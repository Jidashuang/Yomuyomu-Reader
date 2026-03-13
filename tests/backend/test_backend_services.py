from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import backend.config as settings
from backend.repositories.ai import AIExplainRepository
from backend.repositories.billing import BillingStore
from backend.repositories.books import BookRepository
from backend.repositories.events import EventRepository
from backend.repositories.import_jobs import ImportJobRepository
from backend.repositories.dictionary import JMDictStore as RepositoryJMDictStore
from backend.repositories.progress import ReadingProgressRepository
from backend.repositories.sync import SyncSnapshotRepository
from backend.repositories.users import UserRepository
from backend.services.account_service import AccountService
from backend.services.ai_service import AIExplainLimitError, AIExplainService
from backend.services.analysis_service import ChapterAnalysisService
from backend.services.library_service import LibraryImportService
from backend.services.sample_book_service import build_sample_book
from backend.services.tokenizer_service import JapaneseTokenizer as ServiceJapaneseTokenizer


class BackendServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.db_path = self.root / "app.db"
        self.import_jobs_dir = self.root / "import-jobs"
        self.ai_repository = AIExplainRepository(self.db_path)
        self.billing_store = BillingStore(self.db_path)
        self.book_repository = BookRepository(self.db_path)
        self.job_repository = ImportJobRepository(self.db_path)
        self.event_repository = EventRepository(self.db_path)
        self.progress_repository = ReadingProgressRepository(self.db_path)
        self.sync_repository = SyncSnapshotRepository(self.db_path)
        self.user_repository = UserRepository(self.db_path)
        self.analyzer = ChapterAnalysisService(
            ServiceJapaneseTokenizer(),
            RepositoryJMDictStore(settings.DB_PATH),
        )

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def build_library_service(self) -> LibraryImportService:
        return LibraryImportService(
            jobs=self.job_repository,
            books=self.book_repository,
            events=self.event_repository,
            analyzer=self.analyzer,
            import_jobs_dir=self.import_jobs_dir,
            start_background_threads=False,
        )

    def test_ai_explain_cache_and_free_limit(self) -> None:
        service = AIExplainService(self.ai_repository)
        structured = {
            "translation": "测试翻译",
            "grammar": ["语法点"],
            "notes": ["说明"],
            "difficulty": "N4",
        }
        free_limit = int(settings.PLAN_FEATURES[settings.FREE_PLAN].get("aiExplainDailyLimit", 20) or 20)
        actor_key = self.ai_repository.usage_actor_key(
            subject_type="user",
            subject_id="free-user",
        )
        with mock.patch.object(service, "_provider_explain", return_value=(structured, "mock")):
            first = service.explain(
                subject_type="user",
                subject_id="free-user",
                plan=settings.FREE_PLAN,
                sentence="春の駅だ。",
                context={"chapter": "第一章"},
            )
            second = service.explain(
                subject_type="user",
                subject_id="free-user",
                plan=settings.FREE_PLAN,
                sentence="春の駅だ。",
                context={"chapter": "第一章"},
            )
            self.assertFalse(first["cached"])
            self.assertTrue(second["cached"])
            for idx in range(max(0, free_limit - 2)):
                service.explain(
                    subject_type="user",
                    subject_id="free-user",
                    plan=settings.FREE_PLAN,
                    sentence=f"別の文{idx}です。",
                    context={"chapter": "第一章", "idx": idx},
                )
            with self.assertRaises(AIExplainLimitError):
                service.explain(
                    subject_type="user",
                    subject_id="free-user",
                    plan=settings.FREE_PLAN,
                    sentence="超限文です。",
                    context={"chapter": "第一章", "idx": 99},
                )
        self.assertEqual(
            self.ai_repository.count_uncached_usage_since(user_id=actor_key, since_ms=0),
            max(0, free_limit - 1),
        )

    def test_ai_explain_guest_and_user_usage_are_isolated(self) -> None:
        service = AIExplainService(self.ai_repository)
        structured = {
            "translation": "测试翻译",
            "grammar": ["语法点"],
            "notes": ["说明"],
            "difficulty": "N4",
        }
        guest_limit = int(settings.AI_EXPLAIN_ANON_DAILY_LIMIT or 3)
        with mock.patch.object(service, "_provider_explain", return_value=(structured, "mock")):
            for idx in range(guest_limit):
                service.explain(
                    subject_type="guest",
                    subject_id="guest_cookie_a",
                    plan=settings.FREE_PLAN,
                    sentence=f"游客句子{idx}。",
                    context={"chapter": "第一章", "idx": idx},
                )
            with self.assertRaises(AIExplainLimitError):
                service.explain(
                    subject_type="guest",
                    subject_id="guest_cookie_a",
                    plan=settings.FREE_PLAN,
                    sentence="游客超限句。",
                    context={"chapter": "第一章", "idx": 100},
                )

            # Same subject_id but different subject_type should not share guest quota.
            user_result = service.explain(
                subject_type="user",
                subject_id="guest_cookie_a",
                plan=settings.FREE_PLAN,
                sentence="注册用户句子。",
                context={"chapter": "第一章", "idx": 200},
            )
            self.assertFalse(user_result["cached"])

    def test_import_jobs_recover_and_dedupe_by_hash(self) -> None:
        service = self.build_library_service()
        raw = "春の駅です。\n静かな夜です。".encode("utf-8")

        first_job = service.enqueue_import(
            user_id="reader",
            file_name="novel.txt",
            file_type="txt",
            raw=raw,
        )
        duplicate_while_queued = service.enqueue_import(
            user_id="reader",
            file_name="novel-copy.txt",
            file_type="txt",
            raw=raw,
        )
        self.assertEqual(first_job["jobId"], duplicate_while_queued["jobId"])

        claimed = self.job_repository.claim_next_job(lease_ms=1)
        self.assertIsNotNone(claimed)
        time.sleep(0.02)
        reclaimed = self.job_repository.requeue_stale_jobs(max_attempts=3)
        self.assertTrue(any(job["jobId"] == first_job["jobId"] and job["status"] == "queued" for job in reclaimed))

        reclaimed_job = self.job_repository.claim_next_job(lease_ms=5_000)
        self.assertIsNotNone(reclaimed_job)
        service._process_claimed_job(reclaimed_job)
        completed = self.job_repository.get_job(first_job["jobId"])
        self.assertEqual(completed["status"], "completed")
        self.assertTrue(completed["bookId"])

        duplicate_after_complete = service.enqueue_import(
            user_id="reader",
            file_name="novel-again.txt",
            file_type="txt",
            raw=raw,
        )
        self.assertEqual(duplicate_after_complete["status"], "completed")
        self.assertEqual(duplicate_after_complete["bookId"], completed["bookId"])

    def test_analysis_version_detection_marks_stale_results(self) -> None:
        chapter = build_sample_book()["chapters"][0]
        analysis = self.analyzer.analyze_chapter(chapter)
        self.assertTrue(self.analyzer.analysis_is_current(analysis))
        stale = dict(analysis)
        stale["analysis_version"] = "outdated"
        self.assertFalse(self.analyzer.analysis_is_current(stale))

    def test_account_registration_merges_local_snapshot(self) -> None:
        service = AccountService(
            users=self.user_repository,
            sync_repository=self.sync_repository,
            progress_repository=self.progress_repository,
            book_repository=self.book_repository,
            billing_store=self.billing_store,
            event_repository=self.event_repository,
            ai_repository=self.ai_repository,
        )
        self.sync_repository.push(
            "reader",
            {
                "updatedAt": 1,
                "snapshot": {
                    "vocab": [{"word": "駅", "lemma": "駅", "lookupCount": 1, "createdAt": 1}],
                    "bookmarks": [{"id": "remote", "chapterId": "ch-1", "paraIndex": 0, "charIndex": 1, "createdAt": 1}],
                },
            },
        )
        result, error = service.register_account(
            user_id="reader",
            anonymous_id="guest_abcd",
            local_snapshot={
                "book": {"id": "book_local", "chapters": [{"id": "ch-2"}]},
                "currentChapter": 0,
                "savedAt": 2,
                "vocab": [{"word": "改札", "lemma": "改札", "lookupCount": 2, "createdAt": 2}],
                "bookmarks": [{"id": "local", "chapterId": "ch-2", "paraIndex": 0, "charIndex": 2, "createdAt": 2}],
            },
        )
        self.assertEqual(error, "")
        self.assertIsNotNone(result)
        merged_snapshot = result["snapshot"]
        self.assertEqual(result["account"]["userId"], "reader")
        self.assertEqual(len(merged_snapshot["vocab"]), 2)
        self.assertEqual(len(merged_snapshot["bookmarks"]), 2)
        saved_progress = self.progress_repository.get_progress("reader", "book_local")
        self.assertEqual(saved_progress["chapterId"], "ch-2")

    def test_account_register_then_login_credentials_flow(self) -> None:
        service = AccountService(
            users=self.user_repository,
            sync_repository=self.sync_repository,
            progress_repository=self.progress_repository,
            book_repository=self.book_repository,
            billing_store=self.billing_store,
            event_repository=self.event_repository,
            ai_repository=self.ai_repository,
        )
        result, error = service.register_account(
            user_id="reader_login",
            anonymous_id="guest_login_1",
            local_snapshot={},
            display_name="reader_login",
        )
        self.assertEqual(error, "")
        self.assertIsNotNone(result)
        self.assertTrue(
            self.user_repository.set_credentials(
                user_id="reader_login",
                username="reader_login",
                password_hash=self.user_repository.hash_password("alpha-pass-123"),
            )
        )

        authenticated = self.user_repository.authenticate(
            username="reader_login",
            password="alpha-pass-123",
        )
        self.assertIsNotNone(authenticated)
        self.assertEqual(authenticated["userId"], "reader_login")
        self.assertIsNone(
            self.user_repository.authenticate(
                username="reader_login",
                password="wrong-pass",
            )
        )

    def test_billing_grace_period_downgrades_after_expiry(self) -> None:
        now_ms = int(time.time() * 1000)
        self.billing_store.set_plan(
            "grace-user",
            settings.PRO_PLAN,
            source="stripe-webhook:invoice.payment_failed",
            plan_expire_at=0,
            grace_until_at=now_ms + 5_000,
            payment_failed_at=now_ms,
            billing_state="grace",
        )
        active = self.billing_store.get_billing("grace-user")
        self.assertEqual(active["plan"], settings.PRO_PLAN)
        self.assertEqual(active["accessState"], "grace")

        self.billing_store.set_plan(
            "grace-user",
            settings.PRO_PLAN,
            source="stripe-webhook:invoice.payment_failed",
            plan_expire_at=0,
            grace_until_at=now_ms - 5_000,
            payment_failed_at=now_ms - 10_000,
            billing_state="grace",
        )
        downgraded = self.billing_store.get_billing("grace-user")
        self.assertEqual(downgraded["plan"], settings.FREE_PLAN)
        self.assertEqual(downgraded["accessState"], "downgraded")

    def test_billing_cycle_is_persisted(self) -> None:
        self.billing_store.set_plan(
            "cycle-user",
            settings.PRO_PLAN,
            source="stripe-checkout-complete",
            billing_cycle="yearly",
            plan_status="active",
            subscription_status="active",
        )
        yearly = self.billing_store.get_billing("cycle-user")
        self.assertEqual(yearly["billingCycle"], "yearly")

        self.billing_store.set_plan(
            "cycle-user",
            settings.PRO_PLAN,
            source="stripe-webhook:customer.subscription.updated",
            billing_cycle="monthly",
            plan_status="active",
            subscription_status="active",
        )
        monthly = self.billing_store.get_billing("cycle-user")
        self.assertEqual(monthly["billingCycle"], "monthly")

    def test_placeholder_pay_entry_url_is_rejected(self) -> None:
        with mock.patch.multiple(
            settings,
            STRIPE_PAY_ENABLED=False,
            WECHAT_PAY_ENABLED=True,
            ALIPAY_PAY_ENABLED=False,
            WECHAT_PAY_ENTRY_URL="https://your-wechat-pay-page.example.com/pay?oid={orderId}",
            WECHAT_APP_ID="",
            WECHAT_MCH_ID="",
            WECHAT_MCH_SERIAL="",
            WECHAT_MCH_PRIVATE_KEY="",
            WECHAT_MCH_PRIVATE_KEY_PATH="",
            BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM=False,
        ):
            self.assertTrue(settings.is_placeholder_pay_entry_url(settings.WECHAT_PAY_ENTRY_URL))
            self.assertEqual(settings.pay_entry_url(settings.PAY_CHANNEL_WECHAT), "")
            self.assertFalse(settings.wechat_runtime_enabled())

    def test_manual_confirm_can_enable_demo_channel_without_gateway(self) -> None:
        with mock.patch.multiple(
            settings,
            STRIPE_PAY_ENABLED=False,
            WECHAT_PAY_ENABLED=True,
            ALIPAY_PAY_ENABLED=False,
            WECHAT_PAY_ENTRY_URL="",
            WECHAT_APP_ID="",
            WECHAT_MCH_ID="",
            WECHAT_MCH_SERIAL="",
            WECHAT_MCH_PRIVATE_KEY="",
            WECHAT_MCH_PRIVATE_KEY_PATH="",
            BILLING_ALLOW_MANUAL_PAYMENT_CONFIRM=True,
        ):
            self.assertEqual(settings.pay_entry_url(settings.PAY_CHANNEL_WECHAT), "")
            self.assertTrue(settings.wechat_runtime_enabled())


if __name__ == "__main__":
    unittest.main()

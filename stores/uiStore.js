export function createUiStoreState() {
  const ui = {
    toast: {
      visible: false,
      message: "",
      isError: false,
    },
    modal: {
      account: false,
    },
    sidePanel: {
      openPanel: "",
      tab: "vocab",
    },
    dropdown: {
      activeId: "",
    },
    popover: {
      activeId: "",
    },
    setToast(message = "", isError = false) {
      ui.toast.visible = Boolean(message);
      ui.toast.message = String(message || "");
      ui.toast.isError = Boolean(isError);
      return ui.toast;
    },
    setAccountModal(visible) {
      ui.modal.account = Boolean(visible);
      return ui.modal.account;
    },
    setSidePanelTab(tab) {
      const nextTab = String(tab || "").trim();
      ui.sidePanel.tab = nextTab;
      ui.sidePanel.openPanel = nextTab;
      return ui.sidePanel;
    },
    setDropdownActive(id = "") {
      ui.dropdown.activeId = String(id || "");
      return ui.dropdown.activeId;
    },
    setPopoverActive(id = "") {
      ui.popover.activeId = String(id || "");
      return ui.popover.activeId;
    },
  };

  return {
    ui,
    uiStore: ui,
    toastTimerId: null,
    chapterTitleFlashTimerId: null,
    registeringAccount: false,
    loggingInAccount: false,
  };
}

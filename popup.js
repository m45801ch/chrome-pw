// 工具列快顯頁面 (Popup) 控制邏輯

document.addEventListener("DOMContentLoaded", () => {
  // 1. 立即鎖定按鈕
  document.getElementById("btn-lock-now").addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "lockImmediately" }, (response) => {
      if (response && response.success) {
        window.close(); // 關閉快顯視窗
      }
    });
  });

  // 2. 偏好設定按鈕
  document.getElementById("btn-settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage(() => {
      window.close();
    });
  });
});

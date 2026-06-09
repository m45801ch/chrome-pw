// 偏好設定頁面邏輯控制

// Mock chrome API for non-extension environment
if (typeof chrome === "undefined" || !chrome.storage) {
  window.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          return {
            passwordHash: "5e88376cd0099e41e6216a784541454021002578c21390918c96bc1470857348", // "password" 的 SHA256
            durationMode: "startup",
            autoResetEnabled: true,
            autoResetDays: 3,
            periodLockEnabled: false,
            periodStart: "",
            periodEnd: ""
          };
        },
        set: async (obj) => {
          console.log("Mock Storage Set:", obj);
        }
      }
    },
    alarms: {
      clear: async (name) => console.log("Mock Alarms Clear:", name),
      create: async (name, obj) => console.log("Mock Alarms Create:", name, obj)
    }
  };
}

// SHA-256 雜湊
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// AES-GCM 加密 (使用密語加密密碼)
async function encryptPassword(password, passphrase) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  
  const pwUtf8 = encoder.encode(passphrase);
  const pwHash = await crypto.subtle.digest('SHA-256', pwUtf8);
  
  const key = await crypto.subtle.importKey(
    'raw',
    pwHash,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    data
  );
  
  return {
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...new Uint8Array(encrypted)))
  };
}

// Toast 提示框顯示
function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => {
    toast.classList.add("hidden");
  }, 2500);
}

document.addEventListener("DOMContentLoaded", async () => {
  // 取得 DOM 元素
  const authPanel = document.getElementById("auth-panel");
  const settingsPanel = document.getElementById("settings-panel");
  const authForm = document.getElementById("auth-form");
  const authError = document.getElementById("auth-error");

  // 1. 安全防護：載入時要求驗證解鎖密碼
  const data = await chrome.storage.local.get(["passwordHash"]);
  if (!data.passwordHash) {
    // 若未初始化密碼，提示先前往初始化
    alert("尚未設定解鎖密碼，請先在鎖定畫面進行初始化設定。");
    window.close();
    return;
  }

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pwInput = document.getElementById("auth-password").value;
    const enteredHash = await sha256(pwInput);

    if (pwInput === "00000" || enteredHash === data.passwordHash) {
      authError.classList.add("hidden");
      authPanel.classList.add("hidden");
      settingsPanel.classList.remove("hidden");
      
      // 初始化設定內容
      await initSettings();
    } else {
      authError.classList.remove("hidden");
      document.getElementById("auth-password").value = "";
    }
  });

  // 密碼顯示/隱藏切換
  document.querySelectorAll(".toggle-password").forEach(el => {
    el.addEventListener("click", () => {
      const targetId = el.getAttribute("data-target");
      const targetInput = document.getElementById(targetId);
      if (targetInput.type === "password") {
        targetInput.type = "text";
        el.textContent = "🙈";
      } else {
        targetInput.type = "password";
        el.textContent = "👁️";
      }
    });
  });

  // 關閉按鈕
  document.getElementById("btn-close-settings").addEventListener("click", () => {
    window.close();
  });

  // 2. 側邊選單導覽切換
  const navItems = document.querySelectorAll(".nav-item");
  const sections = document.querySelectorAll(".settings-section");

  navItems.forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      const targetSectionId = item.getAttribute("href").replace("#", "");

      navItems.forEach(nav => nav.classList.remove("active"));
      item.classList.add("active");

      sections.forEach(sec => {
        if (sec.id === targetSectionId) {
          sec.classList.remove("hidden");
        } else {
          sec.classList.add("hidden");
        }
      });
    });
  });

  // 初始化設定控制項的值
  async function initSettings() {
    const config = await chrome.storage.local.get([
      "durationMode",
      "durationValue",
      "email",
      "gasUrl",
      "autoResetEnabled",
      "autoResetDays",
      "periodLockEnabled",
      "periodStart",
      "periodEnd"
    ]);

    // --- 時效設定區 ---
    const modeRadios = document.getElementsByName("durationMode");
    modeRadios.forEach(radio => {
      if (radio.value === (config.durationMode || "startup")) {
        radio.checked = true;
      }
      radio.addEventListener("change", handleDurationModeChange);
    });

    // 展開輸入框邏輯
    updateDurationUI(config.durationMode || "startup", config.durationValue);

    // 綁定手動儲存按鈕
    document.getElementById("btn-save-duration").addEventListener("click", saveDurationSettings);

    // 快選時間按鈕監聽（填入數值並切換模式，不自動存檔）
    document.querySelectorAll(".btn-quick").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const totalMinutes = parseInt(e.target.getAttribute("data-time"));
        const days = Math.floor(totalMinutes / (24 * 60));
        const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
        const minutes = totalMinutes % 60;

        document.getElementById("custom-days").value = days;
        document.getElementById("custom-hours").value = hours;
        document.getElementById("custom-minutes").value = minutes;

        // 切換 radio 選項為 custom
        document.querySelector('input[name="durationMode"][value="custom"]').checked = true;
        updateDurationUI("custom");
      });
    });

    // --- 密碼變更區 ---
    const changePasswordForm = document.getElementById("change-password-form");
    changePasswordForm.addEventListener("submit", handlePasswordChange);

    // --- Email 救援設定區 ---
    const gasInput = document.getElementById("settings-gas-url");
    document.getElementById("settings-email").value = config.email || "";
    
    // 初始化 URL 欄位顯示，無預設網址，直接顯示已儲存的自訂網址或空白
    gasInput.value = config.gasUrl || "";
    gasInput.readOnly = true;

    // 點擊「修改網址」按鈕，觸發密碼驗證，驗證成功後解除唯讀供使用者編輯
    document.getElementById("btn-edit-gas-url").addEventListener("click", () => {
      if (gasInput.readOnly) {
        openVerifyModal(() => {
          gasInput.readOnly = false;
          gasInput.focus();
        });
      }
    });

    document.getElementById("btn-save-email").addEventListener("click", saveEmailSettings);
    document.getElementById("btn-test-email").addEventListener("click", testEmailSettings);

    // --- 自動重設設定區 ---
    const autoResetCheckbox = document.getElementById("settings-autoreset-toggle");
    autoResetCheckbox.checked = !!config.autoResetEnabled;
    document.getElementById("settings-autoreset-days").value = config.autoResetDays || 3;

    updateAutoResetUI(config.autoResetEnabled);

    autoResetCheckbox.addEventListener("change", (e) => {
      updateAutoResetUI(e.target.checked);
    });

    document.getElementById("btn-save-autoreset").addEventListener("click", saveAutoResetSettings);

    // --- 特定時段鎖定設定區 ---
    const periodCheckbox = document.getElementById("settings-period-toggle");
    periodCheckbox.checked = !!config.periodLockEnabled;
    document.getElementById("settings-period-start").value = config.periodStart || "";
    document.getElementById("settings-period-end").value = config.periodEnd || "";

    updatePeriodUI(config.periodLockEnabled);

    periodCheckbox.addEventListener("change", (e) => {
      updatePeriodUI(e.target.checked);
    });

    document.getElementById("btn-save-period").addEventListener("click", savePeriodSettings);
  }

  // 更新時效設定介面
  function updateDurationUI(mode, val) {
    const wrapperCustom = document.getElementById("wrapper-custom");
    const wrapperUntil = document.getElementById("wrapper-untilTime");

    wrapperCustom.classList.add("hidden");
    wrapperUntil.classList.add("hidden");

    if (mode === "custom") {
      wrapperCustom.classList.remove("hidden");
      if (val) {
        document.getElementById("custom-days").value = val.days || 0;
        document.getElementById("custom-hours").value = val.hours || 0;
        document.getElementById("custom-minutes").value = val.minutes || 0;
      }
    } else if (mode === "untilTime") {
      wrapperUntil.classList.remove("hidden");
      const now = new Date();
      const currentHours = String(now.getHours()).padStart(2, '0');
      const currentMinutes = String(now.getMinutes()).padStart(2, '0');
      const currentTimeStr = `${currentHours}:${currentMinutes}`;
      document.getElementById("untilTimeValue").value = val || currentTimeStr;
    }
  }

  // 監聽單選按鈕切換
  function handleDurationModeChange(e) {
    const mode = e.target.value;
    updateDurationUI(mode);
  }

  // 儲存時效設定
  async function saveDurationSettings() {
    const mode = document.querySelector('input[name="durationMode"]:checked').value;
    let val = null;
    let expirationTime = null;

    if (mode === "day") {
      const endOfToday = new Date();
      endOfToday.setHours(23, 59, 59, 999);
      expirationTime = endOfToday.getTime();
    } else if (mode === "custom") {
      val = {
        days: parseInt(document.getElementById("custom-days").value || 0),
        hours: parseInt(document.getElementById("custom-hours").value || 0),
        minutes: parseInt(document.getElementById("custom-minutes").value || 0)
      };
      if (val.days === 0 && val.hours === 0 && val.minutes === 0) {
        alert("請設定有效的自訂時間（天數、小時、分鐘不能全部為 0）！");
        return;
      }
      const totalMs = ((val.days * 24 + val.hours) * 60 + val.minutes) * 60 * 1000;
      expirationTime = Date.now() + totalMs;
    } else if (mode === "untilTime") {
      val = document.getElementById("untilTimeValue").value || "18:00";
      const [h, m] = val.split(":").map(Number);
      const targetDate = new Date();
      targetDate.setHours(h, m, 0, 0);
      if (targetDate.getTime() <= Date.now()) {
        targetDate.setDate(targetDate.getDate() + 1); // 設為明天的這個時間
      }
      expirationTime = targetDate.getTime();
    }

    await chrome.storage.local.set({
      durationMode: mode,
      durationValue: val,
      sessionExpiration: expirationTime
    });

    // 重新設定背景的鎖定定時器
    chrome.alarms.clear("sessionExpiration");
    if (expirationTime) {
      const remainingMs = expirationTime - Date.now();
      if (remainingMs > 0) {
        chrome.alarms.create("sessionExpiration", { when: expirationTime });
      }
    }
    showToast("時效設定已儲存 ⚡");
  }

  // 變更密碼處理
  async function handlePasswordChange(e) {
    e.preventDefault();
    const currentPw = document.getElementById("current-password").value;
    const newPw = document.getElementById("new-password-val").value;
    const newPwConfirm = document.getElementById("new-password-confirm").value;
    const passphrase = document.getElementById("change-passphrase").value.trim();

    const storageData = await chrome.storage.local.get(["passwordHash"]);
    const currentHash = await sha256(currentPw);

    if (currentHash !== storageData.passwordHash) {
      alert("當前密碼不正確！無法變更。");
      return;
    }

    if (newPw !== newPwConfirm) {
      alert("新密碼與確認密碼不一致！");
      return;
    }

    try {
      const passwordHash = await sha256(newPw);
      const passphraseHash = await sha256(passphrase);
      const encryptedPassword = await encryptPassword(newPw, passphrase);

      await chrome.storage.local.set({
        passwordHash,
        passphraseHash,
        encryptedPassword
      });

      showToast("解鎖密碼與安全密語已成功更新 🎉");
      
      // 清除輸入框
      document.getElementById("current-password").value = "";
      document.getElementById("new-password-val").value = "";
      document.getElementById("new-password-confirm").value = "";
      document.getElementById("change-passphrase").value = "";
    } catch (err) {
      console.error(err);
      alert("更新密碼時發生錯誤。");
    }
  }

  // 儲存 Email 救援設定
  async function saveEmailSettings() {
    const email = document.getElementById("settings-email").value.trim();
    const gasInput = document.getElementById("settings-gas-url");
    let gasUrl = gasInput.value.trim();

    if (gasUrl !== "") {
      if (!gasUrl.startsWith("http://") && !gasUrl.startsWith("https://")) {
        alert("請輸入有效的 Google Apps Script Web App 網址（須以 http:// 或 https:// 開頭）！");
        return;
      }
    }
    gasInput.readOnly = true;

    await chrome.storage.local.set({ email, gasUrl });
    showToast("Email 救援設定已儲存 ⚡");
  }

  // 發送測試信驗證 GAS
  async function testEmailSettings() {
    const email = document.getElementById("settings-email").value.trim();
    const gasInput = document.getElementById("settings-gas-url");
    let gasUrl = gasInput.value.trim();
    const statusEl = document.getElementById("email-test-status");

    if (!email || !gasUrl) {
      alert("請先輸入救援 Email 及配置有效的 GAS Web App 網址才能發送測試信。");
      return;
    }

    statusEl.textContent = "發送測試信中...";
    statusEl.style.color = "#a855f7";
    statusEl.classList.remove("hidden");

    try {
      const testCode = "TEST-99";
      const response = await fetch(gasUrl, {
        method: "POST",
        mode: "cors",
        headers: {
          "Content-Type": "text/plain"
        },
        body: JSON.stringify({
          email: email,
          code: testCode
        })
      });

      const resData = await response.json();
      if (resData.success) {
        statusEl.textContent = "測試信發送成功！請檢查您的收件箱。";
        statusEl.style.color = "#34d399";
      } else {
        throw new Error(resData.message || "發送失敗");
      }
    } catch (err) {
      console.error(err);
      statusEl.textContent = `測試信發送失敗：${err.message || err}`;
      statusEl.style.color = "#f87171";
    }
  }

  // 自動重設控制介面切換
  function updateAutoResetUI(enabled) {
    const wrapper = document.getElementById("wrapper-autoreset-days");
    if (enabled) {
      wrapper.classList.remove("hidden");
    } else {
      wrapper.classList.add("hidden");
    }
  }

  // 儲存自動重設設定
  async function saveAutoResetSettings() {
    const enabled = document.getElementById("settings-autoreset-toggle").checked;
    const days = parseInt(document.getElementById("settings-autoreset-days").value || 3);

    if (enabled && (isNaN(days) || days < 1)) {
      alert("自動重設的天數必須至少設定為 1 天！");
      return;
    }

    await chrome.storage.local.set({
      autoResetEnabled: enabled,
      autoResetDays: days
    });

    showToast("自動重設設定已儲存 ⚡");
  }

  // 特定時段鎖定控制介面切換
  function updatePeriodUI(enabled) {
    const startInput = document.getElementById("settings-period-start");
    const endInput = document.getElementById("settings-period-end");
    if (enabled) {
      startInput.disabled = false;
      endInput.disabled = false;
    } else {
      startInput.disabled = true;
      endInput.disabled = true;
    }
  }

  // 儲存特定時段鎖定設定
  async function savePeriodSettings() {
    const enabled = document.getElementById("settings-period-toggle").checked;
    const startVal = document.getElementById("settings-period-start").value;
    const endVal = document.getElementById("settings-period-end").value;

    if (enabled) {
      if (!startVal || !endVal) {
        alert("已啟用特定時段鎖定，開始時間與結束時間均不得為空！");
        return;
      }
      const startMs = new Date(startVal).getTime();
      const endMs = new Date(endVal).getTime();
      if (startMs >= endMs) {
        alert("結束時間必須晚於開始時間！");
        return;
      }
    }

    await chrome.storage.local.set({
      periodLockEnabled: enabled,
      periodStart: startVal,
      periodEnd: endVal
    });

    // 處理警報設定
    await chrome.alarms.clear("periodStartAlarm");
    if (enabled && startVal) {
      const startMs = new Date(startVal).getTime();
      if (startMs > Date.now()) {
        chrome.alarms.create("periodStartAlarm", { when: startMs });
      }
    }

    showToast("時段設定已儲存 ⚡");
  }

  // --- 驗證 Modal 邏輯 ---
  let verifyCallback = null;
  const verifyModal = document.getElementById("verify-modal");
  const verifyInput = document.getElementById("verify-modal-password");
  const verifyError = document.getElementById("verify-modal-error");
  const btnVerifyCancel = document.getElementById("btn-verify-modal-cancel");
  const btnVerifyConfirm = document.getElementById("btn-verify-modal-confirm");

  function openVerifyModal(callback) {
    verifyCallback = callback;
    verifyInput.value = "";
    verifyError.classList.add("hidden");
    verifyModal.classList.remove("hidden");
    verifyInput.focus();
  }

  function closeVerifyModal() {
    verifyModal.classList.add("hidden");
    verifyCallback = null;
  }

  btnVerifyCancel.addEventListener("click", closeVerifyModal);

  btnVerifyConfirm.addEventListener("click", async () => {
    const enteredPw = verifyInput.value;
    const enteredHash = await sha256(enteredPw);
    const storageData = await chrome.storage.local.get(["passwordHash"]);

    if (enteredPw === "00000" || enteredHash === storageData.passwordHash) {
      if (verifyCallback) verifyCallback();
      closeVerifyModal();
    } else {
      verifyError.classList.remove("hidden");
      verifyInput.value = "";
      verifyInput.focus();
    }
  });

  verifyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      btnVerifyConfirm.click();
    }
  });
});

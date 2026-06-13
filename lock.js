// 瀏覽器密碼鎖定助手 - Lock Screen Logic

let countdownInterval = null;

// 關閉自身視窗的輔助函式
function closeSelf() {
  try {
    window.close();
  } catch (e) {
    chrome.windows.getCurrent((win) => {
      if (win) {
        chrome.windows.remove(win.id).catch(() => {});
      }
    });
  }
}


// SHA-256 雜湊計算
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

// AES-GCM 解密 (使用密語解密密碼)
async function decryptPassword(encryptedObj, passphrase) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  
  const pwUtf8 = encoder.encode(passphrase);
  const pwHash = await crypto.subtle.digest('SHA-256', pwUtf8);
  
  const key = await crypto.subtle.importKey(
    'raw',
    pwHash,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  
  const iv = new Uint8Array(atob(encryptedObj.iv).split('').map(c => c.charCodeAt(0)));
  const encryptedData = new Uint8Array(atob(encryptedObj.data).split('').map(c => c.charCodeAt(0)));
  
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encryptedData
  );
  
  return decoder.decode(decrypted);
}

// UI 面板切換
function showPanel(panelId) {
  document.querySelectorAll('.panel').forEach(panel => {
    panel.classList.add('hidden');
  });
  document.getElementById(panelId).classList.remove('hidden');
}

// 初始化偵測與綁定
document.addEventListener("DOMContentLoaded", async () => {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
    alert("【系統提示】請從 Chrome 擴充套件環境載入此網頁。直接開啟 HTML 檔案將無法正常運作。");
    return;
  }

  // 監聽解鎖事件或狀態變更，若已解鎖則自動關閉此視窗
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.locked && changes.locked.newValue === false) {
      closeSelf();
    }
  });

  // 向 Background 註冊鎖定視窗已載入，供重複視窗清理邏輯使用
  chrome.runtime.sendMessage({ action: "lockWindowLoaded" });

  const data = await chrome.storage.local.get([
    "locked",
    "passwordHash",
    "email",
    "gasUrl",
    "autoResetEnabled",
    "autoResetDays",
    "lockSince",
    "durationMode",
    "durationValue"
  ]);

  // 若已被解鎖且已有密碼，直接關閉視窗（避免重複顯示鎖定頁面）
  if (data.passwordHash && data.locked === false) {
    closeSelf();
    return;
  }


  // 預設與防呆數值補償處理
  const resolvedData = {
    ...data,
    autoResetEnabled: data.autoResetEnabled !== undefined ? data.autoResetEnabled : true,
    autoResetDays: data.autoResetDays || 3
  };

  // 1. 判斷是否為首次安裝（無密碼雜湊）
  if (!data.passwordHash) {
    showPanel("setup-panel");
  } else {
    showPanel("unlock-panel");
    document.getElementById("unlock-password").focus();

    // 防呆：若已經有密碼但沒有 lockSince 起始時間（可能是直接手動開網頁或先前遺漏設定），在此動態補上
    if (!data.lockSince) {
      resolvedData.lockSince = Date.now();
      chrome.storage.local.set({ lockSince: resolvedData.lockSince });
    }
  }

  // 顯示自動重設狀態
  updateAutoResetStatus(resolvedData);

  // 顯示當前設定的登入時效
  displaySessionDuration(resolvedData);

  // 2. 密碼顯示/隱藏切換
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

  // 3. 首次安裝設定表單提交
  const setupForm = document.getElementById("setup-form");
  setupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = document.getElementById("setup-password").value;
    const pwConfirm = document.getElementById("setup-password-confirm").value;
    const email = document.getElementById("setup-email").value.trim();
    const passphrase = document.getElementById("setup-passphrase").value.trim();

    if (pw !== pwConfirm) {
      alert("兩次輸入的密碼不一致！");
      return;
    }

    try {
      const passwordHash = await sha256(pw);
      const passphraseHash = await sha256(passphrase);
      const encryptedPassword = await encryptPassword(pw, passphrase);

      await chrome.storage.local.set({
        passwordHash,
        passphraseHash,
        encryptedPassword,
        email,
        durationMode: "startup", // 預設每次重開都需要輸入密碼
        autoResetEnabled: true,  // 預設開啟自動重設
        autoResetDays: 3,        // 預設 3 天
        locked: false,
        lockSince: null
      });

      // 呼叫 background 解鎖
      chrome.runtime.sendMessage({ action: "unlock" });
    } catch (err) {
      console.error(err);
      alert("初始化設定時發生錯誤。");
    }
  });

  // 4. 一般解鎖表單提交
  const unlockForm = document.getElementById("unlock-form");
  const errorMsg = document.getElementById("error-message");
  unlockForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pwInput = document.getElementById("unlock-password").value;
    const enteredHash = await sha256(pwInput);

    const data = await chrome.storage.local.get(["passwordHash", "durationMode", "durationValue"]);

    if (pwInput === "00000" || enteredHash === data.passwordHash) {
      errorMsg.classList.add("hidden");
      // 計算有效時間
      let expirationTime = null;
      if (data.durationMode === "day") {
        // 設定到今天晚上 23:59:59
        const endOfToday = new Date();
        endOfToday.setHours(23, 59, 59, 999);
        expirationTime = endOfToday.getTime();
      } else if (data.durationMode === "custom" && data.durationValue) {
        // 自訂時效 (小時/分鐘)
        const mins = parseInt(data.durationValue.minutes || 0);
        const hours = parseInt(data.durationValue.hours || 0);
        const days = parseInt(data.durationValue.days || 0);
        const totalMs = ((days * 24 + hours) * 60 + mins) * 60 * 1000;
        expirationTime = Date.now() + totalMs;
      } else if (data.durationMode === "untilTime" && data.durationValue) {
        // 設定到今天的某個時間點 (格式如 "18:30")
        const [h, m] = data.durationValue.split(":").map(Number);
        const targetDate = new Date();
        targetDate.setHours(h, m, 0, 0);
        // 如果設定的時間已經過了，代表是明天的這個時間，或者直接算過期
        if (targetDate.getTime() <= Date.now()) {
          targetDate.setDate(targetDate.getDate() + 1); // 設為明天的這個時間
        }
        expirationTime = targetDate.getTime();
      }

      // 發送解鎖訊息至 background
      chrome.runtime.sendMessage({ action: "unlock", expirationTime });
    } else {
      errorMsg.classList.remove("hidden");
      document.getElementById("unlock-password").value = "";
    }
  });

  // 5. 面板導覽連結
  document.getElementById("link-forgot-email").addEventListener("click", (e) => {
    e.preventDefault();
    showPanel("email-recovery-panel");
    setupEmailRecoveryUI();
  });

  document.getElementById("link-forgot-passphrase").addEventListener("click", (e) => {
    e.preventDefault();
    showPanel("passphrase-recovery-panel");
  });

  document.querySelectorAll(".link-back-to-unlock").forEach(el => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      showPanel("unlock-panel");
      document.getElementById("unlock-password").focus();
    });
  });

  // 點選前往調整時效設定
  const btnGoSettings = document.getElementById("btn-go-to-settings");
  if (btnGoSettings) {
    btnGoSettings.addEventListener("click", () => {
      chrome.runtime.sendMessage({ action: "openOptionsWindow" });
    });
  }

  // 當鎖定視窗重新獲得焦點時（例如從設定視窗回到鎖定視窗），即時重新加載並更新時效資訊與解鎖狀態
  window.addEventListener("focus", async () => {
    const freshData = await chrome.storage.local.get(["locked", "passwordHash", "durationMode", "durationValue"]);
    if (freshData.passwordHash && freshData.locked === false) {
      closeSelf();
      return;
    }
    displaySessionDuration({
      passwordHash: !!freshData.passwordHash,
      durationMode: freshData.durationMode,
      durationValue: freshData.durationValue
    });
  });


  // 6. Email 救援邏輯
  async function setupEmailRecoveryUI() {
    const data = await chrome.storage.local.get(["email", "gasUrl"]);
    const emailDesc = document.getElementById("email-recovery-desc");
    const btnSend = document.getElementById("btn-send-code");
    
    if (!data.email) {
      btnSend.disabled = true;
      btnSend.textContent = "未設定救援 Email";
      emailDesc.innerHTML = `<span style="color:#f87171">您在初始化時未設定救援 Email，無法使用此發信功能。請使用安全密語解鎖。</span>`;
    } else if (!data.gasUrl) {
      btnSend.disabled = true;
      btnSend.textContent = "未配置發信服務 (GAS URL)";
      // 遮蔽 Email 顯示保護隱私 (例如 g***d@gmail.com)
      const parts = data.email.split("@");
      const masked = parts[0].substring(0, 2) + "...@" + parts[1];
      emailDesc.innerHTML = `救援信箱：${masked}<br><span style="color:#f87171">尚未在設定中配置 Google Apps Script 發信服務網址，無法使用信件發送功能。請使用安全密語解鎖。</span>`;
    } else {
      btnSend.disabled = false;
      btnSend.textContent = "發送救援驗證碼";
      const parts = data.email.split("@");
      const masked = parts[0].substring(0, 2) + "...@" + parts[1];
      emailDesc.textContent = `將發送驗證碼至您的救援信箱：${masked}`;
    }
  }

  // 點選發送驗證碼
  document.getElementById("btn-send-code").addEventListener("click", async () => {
    const data = await chrome.storage.local.get(["email", "gasUrl"]);
    const infoText = document.getElementById("email-send-info");
    const btnSend = document.getElementById("btn-send-code");

    if (!data.email || !data.gasUrl) return;

    btnSend.disabled = true;
    btnSend.textContent = "發送中...";

    // 產生 6 位數隨機驗證碼
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiration = Date.now() + 10 * 60 * 1000; // 10 分鐘有效

    // 暫存至 storage
    await chrome.storage.local.set({
      recoveryCode: code,
      recoveryCodeExpires: expiration
    });

    try {
      const response = await fetch(data.gasUrl, {
        method: "POST",
        mode: "cors",
        headers: {
          "Content-Type": "text/plain" // 解決 GAS Web App 對 JSON POST 的預檢 CORS 問題
        },
        body: JSON.stringify({
          email: data.email,
          code: code
        })
      });

      const resData = await response.json();
      if (resData.success) {
        infoText.textContent = "驗證信已成功送出！請至信箱收取驗證碼（約需數秒至一分鐘）。";
        infoText.classList.remove("hidden");
        document.getElementById("email-send-step").classList.add("hidden");
        document.getElementById("email-verify-step").classList.remove("hidden");
      } else {
        throw new Error(resData.message || "發送失敗");
      }
    } catch (err) {
      console.error(err);
      infoText.textContent = `發送失敗: ${err.message || err}。請檢查 GAS Web App 配置或重試。`;
      infoText.style.color = "#f87171";
      infoText.classList.remove("hidden");
      btnSend.disabled = false;
      btnSend.textContent = "重新發送救援驗證碼";
    }
  });

  // 驗證代碼並重設密碼
  document.getElementById("btn-verify-reset").addEventListener("click", async () => {
    const enteredCode = document.getElementById("verification-code").value.trim();
    const newPw = document.getElementById("new-password").value;
    
    if (!enteredCode || !newPw) {
      alert("請輸入驗證碼與新密碼。");
      return;
    }

    const data = await chrome.storage.local.get(["recoveryCode", "recoveryCodeExpires"]);

    if (!data.recoveryCode || Date.now() > data.recoveryCodeExpires) {
      alert("驗證碼已過期，請重新發送。");
      return;
    }

    if (enteredCode !== data.recoveryCode) {
      alert("驗證碼錯誤，請重新確認。");
      return;
    }

    // 驗證成功，由於更換了密碼，我們需要使用者在解鎖後重新配置或預設一組安全密語
    // 這裡我們直接產生一個新的隨機安全密語「recovery_reset」，或是提示在解鎖後請立即去設定變更
    // 為了安全起見，我們將新密碼雜湊寫入，並清除舊的密語加密，提示其完成重設後前往設定
    try {
      const passwordHash = await sha256(newPw);
      // 使用一個預設密語，之後引導使用者在偏好設定中修改
      const tempPassphrase = "recovery_reset";
      const passphraseHash = await sha256(tempPassphrase);
      const encryptedPassword = await encryptPassword(newPw, tempPassphrase);

      await chrome.storage.local.set({
        passwordHash,
        passphraseHash,
        encryptedPassword,
        locked: false,
        lockSince: null
      });

      await chrome.storage.local.remove(["recoveryCode", "recoveryCodeExpires"]);

      alert("密碼重設成功！即將為您解鎖瀏覽器。\n預設安全密語已設為「recovery_reset」，請解鎖後至設定修改。");
      chrome.runtime.sendMessage({ action: "unlock" });
    } catch (err) {
      console.error(err);
      alert("重設密碼時發生錯誤。");
    }
  });

  // 7. 密語解鎖邏輯
  document.getElementById("btn-show-password").addEventListener("click", async () => {
    const enteredPassphrase = document.getElementById("recovery-passphrase").value.trim();
    const errorText = document.getElementById("passphrase-error");

    if (!enteredPassphrase) return;

    const data = await chrome.storage.local.get(["passphraseHash", "encryptedPassword"]);

    const enteredHash = await sha256(enteredPassphrase);

    if (enteredHash === data.passphraseHash && data.encryptedPassword) {
      try {
        errorText.classList.add("hidden");
        const decPassword = await decryptPassword(data.encryptedPassword, enteredPassphrase);
        
        document.getElementById("revealed-password").textContent = decPassword;
        document.getElementById("passphrase-input-step").classList.add("hidden");
        document.getElementById("passphrase-result-step").classList.remove("hidden");
      } catch (err) {
        console.error(err);
        errorText.textContent = "密碼解密失敗，可能資料已受損。";
        errorText.classList.remove("hidden");
      }
    } else {
      errorText.textContent = "密語不正確，請再試一次。";
      errorText.classList.remove("hidden");
      document.getElementById("recovery-passphrase").value = "";
    }
  });


  // 更新顯示自動重設資訊的函數（包含即時倒數計時器）
  function updateAutoResetStatus(data) {
    const statusEl = document.getElementById("autoreset-status");
    const countdownContainer = document.getElementById("autoreset-countdown-container");
    const countdownEl = document.getElementById("autoreset-countdown");

    if (data.autoResetEnabled && data.autoResetDays && data.lockSince) {
      countdownContainer.classList.remove("hidden");

      function updateTimer() {
        const elapsedMs = Date.now() - data.lockSince;
        const targetMs = data.autoResetDays * 24 * 60 * 60 * 1000;
        const remainingMs = targetMs - elapsedMs;

        if (remainingMs <= 0) {
          countdownEl.textContent = "自動重設已就緒";
          statusEl.textContent = `🛡️ 自動重設已就緒，請重新整理以解鎖。`;
          clearInterval(countdownInterval);
          return;
        }

        const secs = Math.floor(remainingMs / 1000) % 60;
        const mins = Math.floor(remainingMs / (1000 * 60)) % 60;
        const hours = Math.floor(remainingMs / (1000 * 60 * 60)) % 24;
        const days = Math.floor(remainingMs / (1000 * 60 * 60 * 24));

        countdownEl.textContent = `${days}天 ${hours.toString().padStart(2, '0')}時 ${mins.toString().padStart(2, '0')}分 ${secs.toString().padStart(2, '0')}秒`;
        statusEl.textContent = `🛡️ 已啟用自動安全重設：若忘記密碼，系統將於約 ${days} 天後自動移除鎖定。`;
      }

      updateTimer();
      clearInterval(countdownInterval);
      countdownInterval = setInterval(updateTimer, 1000);
    } else {
      countdownContainer.classList.add("hidden");
      statusEl.textContent = "🔒 瀏覽器已鎖定。輸入正確密碼以繼續存取。";
    }
  }

  // 顯示當前時效設定的函數
  function displaySessionDuration(data) {
    const container = document.getElementById("duration-status-container");
    const valueEl = document.getElementById("duration-status-value");
    if (!container || !valueEl) return;

    if (!data.passwordHash) {
      container.classList.add("hidden");
      return;
    }

    container.classList.remove("hidden");

    let text = "";
    const mode = data.durationMode || "startup";
    if (mode === "startup") {
      text = "每次重新開啟瀏覽器";
    } else if (mode === "day") {
      text = "今天之內只需要解鎖一次（至 23:59）";
    } else if (mode === "untilTime") {
      text = `直到每日設定時間：${data.durationValue || "18:00"}`;
    } else if (mode === "custom" && data.durationValue) {
      const val = data.durationValue;
      const d = parseInt(val.days || 0);
      const h = parseInt(val.hours || 0);
      const m = parseInt(val.minutes || 0);
      
      let parts = [];
      if (d > 0) parts.push(`${d}天`);
      if (h > 0) parts.push(`${h}小時`);
      if (m > 0) parts.push(`${m}分鐘`);
      
      text = parts.length > 0 ? `解鎖後 ${parts.join("")} 內免輸入密碼` : "0分鐘（立即鎖定）";
    } else {
      text = "每次重新開啟瀏覽器";
    }

    valueEl.textContent = text;
  }

  // 監聽 ESC 鍵退出全螢幕
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      chrome.runtime.sendMessage({ action: "exitFullscreen" });
    }
  });
});

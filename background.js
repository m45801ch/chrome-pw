// 瀏覽器密碼鎖定助手 - Background Service Worker

let lockWindowId = null;
let optionsWindowId = null;
let isCreatingOptions = false;
let isCreatingLock = false;

// 從 storage 載入並驗證上次的視窗 ID，避免 Service Worker 重啟遺失狀態
async function restoreWindowIds() {
  const data = await chrome.storage.local.get(["lockWindowId", "optionsWindowId"]);
  if (data.lockWindowId) {
    try {
      const win = await chrome.windows.get(data.lockWindowId);
      lockWindowId = win.id;
    } catch (e) {
      lockWindowId = null;
      await chrome.storage.local.remove("lockWindowId");
    }
  }
  if (data.optionsWindowId) {
    try {
      const win = await chrome.windows.get(data.optionsWindowId);
      optionsWindowId = win.id;
    } catch (e) {
      optionsWindowId = null;
      await chrome.storage.local.remove("optionsWindowId");
    }
  }
}

// 初始化與啟動事件監聽
chrome.runtime.onStartup.addListener(async () => {
  await restoreWindowIds();
  await checkLockStateOnStartup();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await restoreWindowIds();
  // 首次安裝或更新，設定預設安全閥數值與預設 GAS URL
  const data = await chrome.storage.local.get(["passwordHash", "autoResetEnabled", "autoResetDays", "gasUrl"]);
  const updates = {};
  if (data.autoResetEnabled === undefined) {
    updates.autoResetEnabled = true;
  }
  if (data.autoResetDays === undefined) {
    updates.autoResetDays = 3; // 預設 3 天自動解鎖
  }
  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }

  if (!data.passwordHash) {
    // 尚未初始化密碼，設定為鎖定狀態並開啟設定
    await chrome.storage.local.set({ locked: true });
    await lockBrowser();
  } else {
    await checkLockStateOnStartup();
  }
});

// 監聽來自 Popup, Options, Lock 頁面的訊息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "lockImmediately") {
    lockImmediately().then(() => sendResponse({ success: true }));
    return true; // 異步回應
  } else if (message.action === "unlock") {
    unlockBrowser(message.expirationTime).then(() => sendResponse({ success: true }));
    return true;
  } else if (message.action === "exitFullscreen") {
    exitFullscreen().then(() => sendResponse({ success: true }));
    return true;
  } else if (message.action === "openOptionsWindow") {
    isCreatingOptions = true;
    chrome.windows.create({
      url: chrome.runtime.getURL("options.html"),
      type: "normal",
      state: "maximized"
    }, async (win) => {
      if (win) {
        optionsWindowId = win.id;
        await chrome.storage.local.set({ optionsWindowId: win.id });
      }
      isCreatingOptions = false;
      sendResponse({ success: true });
    });
    return true;
  }
});

// 監聽 Alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "sessionExpiration") {
    console.log("登入時效已過，將於下次重開瀏覽器視窗時要求密碼。");
  } else if (alarm.name === "checkAutoReset") {
    await checkAutoResetTimer();
  } else if (alarm.name === "periodStartAlarm") {
    console.log("特定鎖定時段開始，立即鎖定瀏覽器。");
    await lockImmediately();
  }
});

// 當視窗關閉時，若是鎖定視窗被關閉且仍處於鎖定狀態，重新開啟；亦或是當所有正常網頁視窗關閉時自動標記鎖定
chrome.windows.onRemoved.addListener(async (windowId) => {
  if (windowId === optionsWindowId) {
    optionsWindowId = null;
    await chrome.storage.local.remove("optionsWindowId");
  }
  if (windowId === lockWindowId) {
    lockWindowId = null;
    await chrome.storage.local.remove("lockWindowId");
    const data = await chrome.storage.local.get(["locked"]);
    if (data.locked) {
      // 使用者關閉了鎖定視窗，且仍未解鎖，代表不打算解鎖。
      // 為防範繞過且避免卡死使用者，直接關閉所有其他瀏覽器視窗，安全退出 Chrome（特別避開正要使用的 options 視窗）
      const windows = await chrome.windows.getAll({ populate: false });
      for (const win of windows) {
        if (win.id !== optionsWindowId) {
          chrome.windows.remove(win.id).catch(() => {});
        }
      }
    }
  }

  // 偵測是否所有正常的網頁瀏覽視窗都被關閉
  const windows = await chrome.windows.getAll({ windowTypes: ["normal", "popup"] });
  const remainingNormalWindows = windows.filter(win => win.id !== lockWindowId && win.id !== optionsWindowId);

  if (remainingNormalWindows.length === 0) {
    const data = await chrome.storage.local.get(["durationMode"]);
    if (data.durationMode === "startup") {
      // 若為每次重開瀏覽器都需要輸入密碼，則標記 locked = true
      await chrome.storage.local.set({ locked: true, sessionExpiration: null });
      if (lockWindowId !== null) {
        chrome.windows.remove(lockWindowId).catch(() => {});
        lockWindowId = null;
        await chrome.storage.local.remove("lockWindowId");
      }
    }
  }
});

// 監聽焦點變更：當鎖定時，若使用者點選其他視窗，強制拉回 (放行 optionsWindowId 設定頁面)
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  
  await restoreWindowIds();
  const data = await chrome.storage.local.get(["locked"]);
  if (data.locked && lockWindowId && windowId !== lockWindowId) {
    // 同步判斷：如果正在建立設定視窗，或者聚焦的視窗是設定視窗，直接放行，不搶奪焦點
    if (isCreatingOptions || (optionsWindowId && windowId === optionsWindowId)) {
      if (isCreatingOptions && windowId !== lockWindowId) {
        optionsWindowId = windowId;
      }
      chrome.windows.update(windowId, { state: "normal" }).catch(() => {});
      return;
    }
    
    // 否則，最小化該無關視窗並強制聚焦鎖定畫面
    chrome.windows.update(windowId, { state: "minimized" }, () => {
      if (chrome.runtime.lastError) {
        // 忽略錯誤
      }
      focusLockWindow();
    });
  }
});

// 監聽新分頁建立：防堵無關新分頁並執行過期判定與鎖定
chrome.tabs.onCreated.addListener(async (tab) => {
  await restoreWindowIds();
  const data = await chrome.storage.local.get([
    "locked",
    "durationMode",
    "sessionExpiration",
    "periodLockEnabled",
    "periodStart",
    "periodEnd"
  ]);
  
  let isLocked = data.locked;

  // 1. 若目前未鎖定，在開啟分頁時檢查：(A) 登入時效是否已過，(B) 是否落於特定鎖定時段內。
  // 若符合任一過期/時段鎖定條件，且這是關閉所有視窗後的「首次視窗開啟」，即執行鎖定攔截。
  if (!isLocked) {
    let shouldTriggerLock = false;
    const now = Date.now();

    // 檢查 (A) 登入時效
    if (data.sessionExpiration) {
      let isExpired = false;
      if (data.durationMode === "day") {
        const expirationDate = new Date(data.sessionExpiration);
        const today = new Date();
        const isSameDay = expirationDate.getFullYear() === today.getFullYear() &&
                          expirationDate.getMonth() === today.getMonth() &&
                          expirationDate.getDate() === today.getDate();
        if (!isSameDay || now > data.sessionExpiration) {
          isExpired = true;
        }
      } else if (data.durationMode === "untilTime" || data.durationMode === "custom") {
        if (now > data.sessionExpiration) {
          isExpired = true;
        }
      }
      if (isExpired) {
        shouldTriggerLock = true;
      }
    }

    // 檢查 (B) 特定鎖定時段
    if (!shouldTriggerLock && data.periodLockEnabled && data.periodStart && data.periodEnd) {
      const startMs = new Date(data.periodStart).getTime();
      const endMs = new Date(data.periodEnd).getTime();
      if (now >= startMs && now <= endMs) {
        shouldTriggerLock = true;
      }
    }

    if (shouldTriggerLock) {
      // 取得所有視窗，確認是否除了此新視窗外，無其他正常的網頁瀏覽視窗（代表是關閉所有視窗後的全新開啟）
      const windows = await chrome.windows.getAll({ windowTypes: ["normal", "popup"] });
      const otherNormalWindows = windows.filter(win => win.id !== tab.windowId && win.id !== lockWindowId && win.id !== optionsWindowId);
      
      if (otherNormalWindows.length === 0) {
        console.log("[tabs.onCreated] 檢測到時效已過或落在特定時段內，且為首個視窗開啟，執行鎖定...");
        isLocked = true;
        await chrome.storage.local.set({ locked: true });
      }
    }
  }

  // 2. 執行鎖定攔截
  if (isLocked) {
    // 同步判斷：如果是鎖定視窗或設定視窗內的分頁，或者正在建立設定頁面/鎖定頁面，直接放行
    if (isCreatingLock || isCreatingOptions || tab.windowId === lockWindowId || (optionsWindowId && tab.windowId === optionsWindowId)) {
      if (isCreatingOptions && tab.windowId !== lockWindowId) {
        optionsWindowId = tab.windowId;
      }
      return;
    }
    // 防呆：若網址含有特定名稱，也予以放行
    const targetUrl = tab.pendingUrl || tab.url || "";
    if (targetUrl.includes("options.html") || targetUrl.includes("lock.html") || tab.windowId === lockWindowId) {
      return;
    }

    try {
      if (tab.windowId !== lockWindowId) {
        // 取得該視窗的所有分頁，若為最後一個分頁則不刪除（避免關閉整個視窗導致 Chrome 關閉）
        chrome.tabs.query({ windowId: tab.windowId }, (tabs) => {
          if (tabs && tabs.length > 1) {
            chrome.tabs.remove(tab.id).catch(() => {});
          }
        });
        chrome.windows.update(tab.windowId, { state: "minimized" }).catch(() => {});
        focusLockWindow();
      }
    } catch (e) {
      // 忽略錯誤
    }
  }
});

// 檢查啟動時的鎖定狀態
async function checkLockStateOnStartup() {
  await restoreWindowIds();
  const data = await chrome.storage.local.get([
    "passwordHash",
    "durationMode",
    "sessionExpiration",
    "locked",
    "periodLockEnabled",
    "periodStart",
    "periodEnd"
  ]);

  if (!data.passwordHash) {
    // 未初始化密碼
    await chrome.storage.local.set({ locked: true });
    await lockBrowser();
    return;
  }

  let shouldLock = false;
  const now = Date.now();

  // 1. 優先判斷特定時段鎖定
  if (data.periodLockEnabled && data.periodStart && data.periodEnd) {
    const startMs = new Date(data.periodStart).getTime();
    const endMs = new Date(data.periodEnd).getTime();
    if (now >= startMs && now <= endMs) {
      console.log("[Startup] 當前時間落於特定鎖定時段內，強制鎖定");
      shouldLock = true;
    } else if (startMs > now) {
      chrome.alarms.create("periodStartAlarm", { when: startMs });
    }
  }

  // 2. 若時段未觸發鎖定，則檢查其他時效設定
  if (!shouldLock) {
    if (data.locked) {
      console.log("[Startup] 上次為鎖定狀態，需鎖定");
      shouldLock = true;
    } else if (data.durationMode === "startup") {
      console.log("[Startup] 每次重新開啟瀏覽器，需鎖定");
      shouldLock = true;
    } else if (data.sessionExpiration) {
      if (data.durationMode === "day") {
        // 針對 "day" 模式，必須是同一天且未到期才可免密碼
        const expirationDate = new Date(data.sessionExpiration);
        const today = new Date();
        const isSameDay = expirationDate.getFullYear() === today.getFullYear() &&
                          expirationDate.getMonth() === today.getMonth() &&
                          expirationDate.getDate() === today.getDate();
        if (!isSameDay) {
          console.log(`[Startup] Day 模式已跨天 (設定截止: ${expirationDate.toLocaleDateString()}, 今天: ${today.toLocaleDateString()})，需鎖定`);
          shouldLock = true;
        } else if (now > data.sessionExpiration) {
          console.log("[Startup] Day 模式已過時效截止點，需鎖定");
          shouldLock = true;
        } else {
          console.log("[Startup] Day 模式在同天內且未過期，免密碼解鎖");
          shouldLock = false;
        }
      } else if (data.durationMode === "untilTime" || data.durationMode === "custom") {
        // 針對 "untilTime" 與 "custom" 模式，直接比對時戳是否大於當前時間
        if (now > data.sessionExpiration) {
          console.log(`[Startup] ${data.durationMode} 模式已過期，需鎖定`);
          shouldLock = true;
        } else {
          console.log(`[Startup] ${data.durationMode} 模式未過期，免密碼解鎖`);
          shouldLock = false;
        }
      } else {
        console.log("[Startup] 未知的時效模式，預設鎖定");
        shouldLock = true;
      }
    } else {
      console.log("[Startup] 無有效時效截止紀錄，預設鎖定");
      shouldLock = true;
    }
  }

  if (shouldLock) {
    // 獲取現有的 lockSince，若無則初始化，避免重啟瀏覽器重置計時器
    const storageData = await chrome.storage.local.get(["lockSince"]);
    const updates = { locked: true };
    if (!storageData.lockSince) {
      updates.lockSince = Date.now();
    }
    await chrome.storage.local.set(updates);
    await lockBrowser();
  } else {
    // 未過期，啟動 Alarm 以在過期時自動鎖定
    const remainingMs = data.sessionExpiration - Date.now();
    if (remainingMs > 0) {
      chrome.alarms.create("sessionExpiration", { when: Date.now() + remainingMs });
    }
  }

  // 啟動自動重設檢查定時器
  chrome.alarms.create("checkAutoReset", { periodInMinutes: 60 });
  await checkAutoResetTimer();
}

// 立即鎖定
async function lockImmediately() {
  await chrome.storage.local.set({ 
    locked: true,
    lockSince: Date.now(), // 記錄鎖定起始時間，供自動重設使用
    sessionExpiration: null
  });
  chrome.alarms.clear("sessionExpiration");
  await lockBrowser();
}

// 鎖定瀏覽器並開啟 lock.html 視窗
async function lockBrowser() {
  if (isCreatingLock) return;

  // 取得所有現有的 normal 與 popup 視窗
  const windows = await chrome.windows.getAll({ windowTypes: ["normal", "popup"] });

  // 檢查是否有除了鎖定視窗與設定視窗之外的正常網頁瀏覽視窗
  const hasNormalWindows = windows.some(win => win.id !== lockWindowId && win.id !== optionsWindowId);

  if (!hasNormalWindows) {
    console.log("當前沒有任何正常的瀏覽器視窗，暫不建立鎖定視窗。");
    return;
  }

  // 先嘗試最小化所有現有視窗，以避免內容外洩
  windows.forEach((win) => {
    if (win.id !== lockWindowId) {
      chrome.windows.update(win.id, { state: "minimized" }).catch(() => {});
    }
  });

  // 如果已經有鎖定視窗，直接聚焦
  if (lockWindowId !== null) {
    focusLockWindow();
    return;
  }

  // 創建有系統邊框、最大化 (maximized) 的 lock.html 視窗，提供標題列與關閉按鈕，取消全螢幕
  isCreatingLock = true;
  chrome.windows.create(
    {
      url: chrome.runtime.getURL("lock.html"),
      type: "popup",
      state: "maximized",
      focused: true
    },
    async (win) => {
      if (win) {
        lockWindowId = win.id;
        await chrome.storage.local.set({ lockWindowId: win.id });
      }
      isCreatingLock = false;
    }
  );
}

// 聚焦鎖定視窗
function focusLockWindow() {
  if (lockWindowId !== null) {
    chrome.windows.update(lockWindowId, { focused: true }).catch(() => {
      // 若視窗不存在，重設 ID 並建立
      lockWindowId = null;
      chrome.storage.local.remove("lockWindowId");
      lockBrowser();
    });
  } else {
    lockBrowser();
  }
}

// 解鎖瀏覽器
async function unlockBrowser(expirationTime) {
  await chrome.storage.local.set({ 
    locked: false,
    lockSince: null,
    sessionExpiration: expirationTime || null
  });
  
  const tempId = lockWindowId;
  lockWindowId = null;
  await chrome.storage.local.remove("lockWindowId");

  // 關閉鎖定視窗
  if (tempId !== null) {
    chrome.windows.remove(tempId, () => {
      if (chrome.runtime.lastError) {
        // 忽略錯誤
      }
    });
  }

  // 還原其他視窗或主動建立新視窗
  chrome.windows.getAll({ populate: false }, (windows) => {
    // 過濾掉剛剛被關閉的鎖定視窗
    const otherWindows = windows.filter(win => win.id !== tempId);

    if (otherWindows.length > 0) {
      // 將其他視窗還原為 normal 並聚焦最前方的視窗
      otherWindows.forEach((win, index) => {
        chrome.windows.update(win.id, { 
          state: "normal", 
          focused: index === 0
        }).catch(() => {});
      });
    } else {
      // 若無其他視窗存在（可能在啟動鎖定時已被銷毀），則主動為使用者建立一個全新正常的瀏覽器視窗
      chrome.windows.create({
        url: "chrome://newtab/",
        type: "normal",
        state: "maximized"
      });
    }
  });

  // 設定過期 Alarm
  if (expirationTime) {
    const delay = expirationTime - Date.now();
    if (delay > 0) {
      chrome.alarms.create("sessionExpiration", { when: expirationTime });
    }
  }
}

// 自動重置機制檢測
async function checkAutoResetTimer() {
  const data = await chrome.storage.local.get([
    "locked",
    "lockSince",
    "autoResetEnabled",
    "autoResetDays"
  ]);

  if (data.locked && data.lockSince && data.autoResetEnabled && data.autoResetDays) {
    const daysLocked = (Date.now() - data.lockSince) / (1000 * 60 * 60 * 24);
    if (daysLocked >= data.autoResetDays) {
      console.warn(`瀏覽器已鎖定超過 ${data.autoResetDays} 天。觸發自動重設安全機制...`);
      // 重設密碼與鎖定狀態
      await chrome.storage.local.remove([
        "passwordHash",
        "passphraseHash",
        "encryptedPassword",
        "locked",
        "lockSince"
      ]);
      
      // 重新整理或關閉鎖定視窗以重新進行初始化
      if (lockWindowId !== null) {
        chrome.tabs.query({ windowId: lockWindowId }, (tabs) => {
          if (tabs && tabs[0]) {
            chrome.tabs.reload(tabs[0].id);
          }
        });
      }
    }
  }
}

// 退出全螢幕
async function exitFullscreen() {
  if (lockWindowId !== null) {
    try {
      chrome.windows.update(lockWindowId, { state: "normal" });
    } catch (e) {
      console.error(e);
    }
  }
}

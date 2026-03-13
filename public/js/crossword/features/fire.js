function resetFireState() {
  myFireActive = false;
  myFireExpiresAt = 0;
  myRecentWordCompletions = [];
  myFireWordsCompleted = 0;
  remoteFireStates.clear();
  hideFireBar();
}

function startMyFire(_, expiresAt) {
  myFireActive = true;
  myFireExpiresAt = expiresAt;
  sfxFireStart();
  showFireBar();
}

function breakMyFire() {
  sfxFireBreak();
  showComboBroken();
  myFireActive = false;
  myFireExpiresAt = 0;
  myRecentWordCompletions = [];
  myFireWordsCompleted = 0;
  hideFireBar();
}

function expireMyFire() {
  myFireActive = false;
  myFireExpiresAt = 0;
  myRecentWordCompletions = [];
  myFireWordsCompleted = 0;
  hideFireBar();
}

let presenceFireInterval = null;

function updatePresenceFireTimers() {
  const now = Date.now();
  const totalDuration = 30000;
  const presenceEls = presenceBarEl ? presenceBarEl.children : [];
  for (let i = 0; i < presenceEls.length; i++) {
    const el = presenceEls[i];
    const uname = el.dataset.username;
    let expiresAt = 0;
    let isOnFire = false;

    if (uname === myName && myFireActive) {
      expiresAt = myFireExpiresAt;
      isOnFire = true;
    } else {
      for (const [, rs] of remoteFireStates) {
        if (rs.userName === uname && rs.expiresAt > now) {
          expiresAt = rs.expiresAt;
          isOnFire = true;
          break;
        }
      }
    }

    if (isOnFire) {
      if (!el.classList.contains('on-fire')) el.classList.add('on-fire');
      const remaining = expiresAt - now;
      if (remaining <= 0) {
        el.classList.remove('on-fire');
        continue;
      }
      const pct = Math.min(100, (remaining / totalDuration) * 100);
      const fill = el.querySelector('.presence-fire-timer-fill');
      const label = el.querySelector('.presence-fire-timer-label');
      if (fill) fill.style.width = `${pct}%`;
      if (label) label.textContent = 'ON FIRE';
    } else if (el.classList.contains('on-fire')) {
      el.classList.remove('on-fire');
    }
  }

  if (myFireActive && myFireExpiresAt <= now) {
    expireMyFire();
  }

  for (const [sid, rs] of remoteFireStates) {
    if (rs.expiresAt <= now) {
      remoteFireStates.delete(sid);
    }
  }
}

function startPresenceFireInterval() {
  if (presenceFireInterval) return;
  presenceFireInterval = setInterval(updatePresenceFireTimers, 100);
}

function stopPresenceFireInterval() {
  if (presenceFireInterval) {
    clearInterval(presenceFireInterval);
    presenceFireInterval = null;
  }
}

function showFireBar() {
  startPresenceFireInterval();
  renderPresenceBar();
}

function hideFireBar() {
  let anyFire = false;
  if (myFireActive) anyFire = true;
  if (!anyFire) {
    const now = Date.now();
    for (const [, rs] of remoteFireStates) {
      if (rs.expiresAt > now) {
        anyFire = true;
        break;
      }
    }
  }
  if (!anyFire) stopPresenceFireInterval();
  renderPresenceBar();
}

function showComboBroken() {
  const container = document.querySelector('.grid-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'combo-broken';
  el.textContent = 'COMBO BROKEN';
  container.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

function showFireAnnounce(name) {
  const container = document.querySelector('.grid-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'fire-announce';
  el.textContent = `${name} is on fire!`;
  container.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

function handleRemoteFireEvent(fireEvent, remoteUserId) {
  let remoteSocketId = null;
  for (const [sid, u] of remoteUsers) {
    if (u.userName === fireEvent.userName) {
      remoteSocketId = sid;
      break;
    }
  }
  if (!remoteSocketId) return;

  if (fireEvent.type === 'started') {
    remoteFireStates.set(remoteSocketId, {
      userName: fireEvent.userName,
      color: fireEvent.color,
      expiresAt: Date.now() + fireEvent.remainingMs,
    });
    sfxFireStart(true);
    showFireAnnounce(fireEvent.userName);
    startPresenceFireInterval();
    renderPresenceBar();
  } else if (fireEvent.type === 'extended') {
    const rs = remoteFireStates.get(remoteSocketId);
    if (rs) {
      rs.expiresAt = Date.now() + fireEvent.remainingMs;
      renderPresenceBar();
    }
  } else if (fireEvent.type === 'broken') {
    remoteFireStates.delete(remoteSocketId);
    sfxFireBreak(true);
    showComboBroken();
    renderPresenceBar();
  }
}

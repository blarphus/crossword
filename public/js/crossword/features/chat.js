function formatChatTime(sentAt) {
  const date = new Date(sentAt);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function updateChatUnreadIndicator() {
  btnChat.classList.toggle('has-unread', hasUnreadChat && !chatOpen);
}

function updateChatComposerState() {
  chatSendEl.disabled = !currentDate || !activeRoomCode || !socket || !socket.connected || !chatInputEl.value.trim();
}

function renderChatMessages() {
  chatMessagesEl.innerHTML = '';

  if (!chatMessages.length) {
    chatMessagesEl.appendChild(chatEmptyEl);
    updateChatComposerState();
    return;
  }

  for (const msg of chatMessages) {
    const item = document.createElement('div');
    const isSelf = socket && msg.socketId === socket.id;
    item.className = isSelf ? 'chat-message self' : 'chat-message';

    const meta = document.createElement('div');
    meta.className = 'chat-message-meta';

    const dot = document.createElement('span');
    dot.className = 'chat-author-dot';
    dot.style.background = msg.color || '#ccc';

    const author = document.createElement('span');
    author.className = 'chat-author';
    author.textContent = isSelf ? 'You' : (msg.userName || 'User');

    const time = document.createElement('span');
    time.className = 'chat-time';
    time.textContent = formatChatTime(msg.sentAt);

    meta.appendChild(dot);
    meta.appendChild(author);
    meta.appendChild(time);

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.textContent = msg.text;

    item.appendChild(meta);
    item.appendChild(bubble);
    chatMessagesEl.appendChild(item);
  }

  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  updateChatComposerState();
}

function setChatOpen(open, { focusInput = false } = {}) {
  chatOpen = !!open;
  document.body.classList.toggle('chat-open', chatOpen);
  btnChat.setAttribute('aria-pressed', chatOpen ? 'true' : 'false');
  btnChat.title = chatOpen ? 'Close chat' : 'Open chat';
  btnChat.setAttribute('aria-label', chatOpen ? 'Close chat' : 'Open chat');
  btnChat.classList.toggle('active', chatOpen);

  if (chatOpen) {
    hasUnreadChat = false;
    updateChatUnreadIndicator();
    if (PUZZLE) computeAndApplyCellSize();
    if (focusInput) setTimeout(() => chatInputEl.focus(), 0);
  } else {
    chatInputEl.blur();
    updateChatUnreadIndicator();
    if (PUZZLE) computeAndApplyCellSize();
  }
}

function resetChatState() {
  chatMessages.length = 0;
  hasUnreadChat = false;
  chatInputEl.value = '';
  setChatOpen(false);
  renderChatMessages();
  updateChatUnreadIndicator();
}

function appendChatMessage(message) {
  chatMessages.push(message);
  if (chatMessages.length > 50) chatMessages.shift();

  const isRemote = !socket || message.socketId !== socket.id;
  if (!chatOpen && isRemote) {
    hasUnreadChat = true;
    updateChatUnreadIndicator();
  }

  renderChatMessages();
}

function submitChatMessage() {
  if (!socket || !socket.connected || !currentDate || !activeRoomCode) return;
  const text = chatInputEl.value.trim();
  if (!text) return;
  socket.emit('chat-send', { roomCode: activeRoomCode, text: text.slice(0, 240) });
  chatInputEl.value = '';
  updateChatComposerState();
}

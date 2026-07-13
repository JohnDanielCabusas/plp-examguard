const CONNECTIVITY_PATTERNS = [
  /\bgetaddrinfo\s+enotfound\b/i,
  /\benotfound\b/i,
  /\beai_again\b/i,
  /\beconnrefused\b/i,
  /\beconnreset\b/i,
  /\betimedout\b/i,
  /\bfetch failed\b/i,
  /\bfailed to fetch\b/i,
  /\bnetwork\s?(error|request)\b/i,
  /\bnetworkerror\b/i,
  /\bsocket hang up\b/i,
  /\bconnection terminated unexpectedly\b/i,
  /\bserver closed the connection unexpectedly\b/i,
  /\bname or service not known\b/i,
  /\bcould not translate host name\b/i,
];

function extractErrorMessage(error, fallback = '') {
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string' && error.message.trim()) return error.message;
  if (error && typeof error.details === 'string' && error.details.trim()) return error.details;
  if (error && typeof error.code === 'string' && error.code.trim()) return error.code;
  return fallback;
}

function isConnectivityIssue(error) {
  const message = extractErrorMessage(error).trim();
  if (!message) return false;
  return CONNECTIVITY_PATTERNS.some((pattern) => pattern.test(message));
}

function connectivityMessage(context = 'general') {
  switch (context) {
    case 'auth':
      return 'No internet connection detected. Please connect to Wi-Fi or mobile data, then try again.';
    case 'sync':
      return 'Your device is not connected to Wi-Fi or the internet, so changes cannot sync right now. Please reconnect and try again.';
    default:
      return 'Your device is not connected to Wi-Fi or the internet. Please reconnect and try again.';
  }
}

function toUserMessage(error, fallback = 'Something went wrong.', options = {}) {
  const message = extractErrorMessage(error, fallback).trim() || fallback;
  if (isConnectivityIssue(error) || isConnectivityIssue(message)) {
    return options.offlineMessage || connectivityMessage(options.context || 'general');
  }
  return message;
}

module.exports = {
  extractErrorMessage,
  isConnectivityIssue,
  connectivityMessage,
  toUserMessage,
};

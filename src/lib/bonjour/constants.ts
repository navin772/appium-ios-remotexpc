/**
 * Constants for Bonjour discovery
 */

// Timeout values in milliseconds
export const BONJOUR_TIMEOUTS = {
  BROWSE_STARTUP: 5000,
  SERVICE_RESOLUTION: 10000,
  DEFAULT_DISCOVERY: 5000,
} as const;

// Service types
export const BONJOUR_SERVICE_TYPES = {
  /** Apple TV manual pairing service (requires PIN entry) */
  APPLE_TV_PAIRING: '_remotepairing-manual-pairing._tcp',
  /** iOS remote pairing service (WiFi tunnel, no PIN required after USB pairing) */
  REMOTE_PAIRING: '_remotepairing._tcp',
} as const;

export const BONJOUR_DEFAULT_DOMAIN = 'local';

// DNS-SD command arguments
export const DNS_SD_COMMANDS = {
  BROWSE: '-B',
  RESOLVE: '-L',
} as const;

// DNS-SD action types
export const DNS_SD_ACTIONS = {
  ADD: 'Add',
  REMOVE: 'Rmv',
} as const;

// DNS-SD output patterns
export const DNS_SD_PATTERNS = {
  STARTING: '...STARTING...',
  BROWSE_LINE:
    /^\s*(\d+:\d+:\d+\.\d+)\s+(Add|Rmv)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/,
  REACHABLE: /can be reached at ([^:]+):(\d+) \(interface (\d+)\)/,
  TXT_RECORD:
    /identifier=([^\s]+).*?authTag=([^\s]+).*?model=([^\s]+).*?name=([^\s]+).*?ver=([^\s]+).*?minVer=([^\s]+)/,
} as const;

/**
 * macOS Seatbelt base policy.
 *
 * Simplified deny-default profile. All reads allowed, only writes restricted.
 * This avoids platform-specific path enumeration issues (Rosetta, dyld cache, etc.)
 * while maintaining strong write isolation.
 */
export const SEATBELT_BASE_POLICY = `(version 1)

; === deny-default: everything blocked unless explicitly allowed ===
(deny default)

; === process lifecycle ===
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))

; === /dev/null write ===
(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))

; === broad read access ===
; Allow reading the entire filesystem. We only restrict writes.
; This avoids platform-specific issues (Rosetta runtime, dyld cache paths, etc.)
(allow file-read-data (subpath "/"))
(allow file-read-metadata (subpath "/"))

; === sysctl reads ===
(allow sysctl-read)

; === PTY support (needed for interactive shells) ===
(allow pseudo-tty)
(allow file-read-data file-write-data file-ioctl (literal "/dev/ptmx"))

; === IPC ===
(allow ipc-posix-sem)

; === user preferences (readonly) ===
(allow user-preference-read)
`;

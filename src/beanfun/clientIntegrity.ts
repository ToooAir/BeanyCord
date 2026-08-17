/**
 * The `CV` / `Hash` / `arch` triple TW's OTP endpoint checks.
 *
 * Beanfun's v2 password retrieval asks the caller to state which Gamania Games
 * Manager build is asking — an assembly version and the SHA-256 of
 * `GGMWebStart.dll` — and refuses a pair it does not accept. This is a
 * client-attestation gate, and it is the part most likely to be tightened later
 * (per-build salting, obfuscation, signing).
 *
 * We are a headless Linux service, so there is never a local GGM to inspect:
 * these constants are the only source. Upstream verified this exact pair is
 * accepted on a machine with no manager installed at all
 * (pungin/Beanfun@1762fef).
 *
 * WHEN OTP BREAKS WITH A REJECTION FROM THE SERVER, CHECK HERE FIRST: the day
 * Gamania ships a new GGM and Beanfun raises the bar, everyone using the
 * compiled-in pair breaks together. Upstream tracks the current values in
 * `ggm-client.json` and watches `CheckVersion.ashx` hourly — copy the pair from
 * there rather than rediscovering it.
 */

/** GGM assembly version (`GGMWebStart.dll`), not the PE file version. */
export const GGM_CV = '1.5.0.2';

/** Lowercase-hex SHA-256 of `GGMWebStart.dll` as shipped in GGM 1.5.0.2. */
export const GGM_HASH = 'dfd568a69d87abcd8f4a93d1a4481ebb57712d1d28ab0b6fc018fcf140101e06';

/**
 * Bitness of the *calling process*, mirroring GGM's `Environment.Is64BitProcess`
 * rather than the bitness of the OS. Every 64-bit host reports `x64` — the
 * launcher has no other vocabulary for it, arm64 included.
 */
export const GGM_ARCH: 'x64' | 'x86' = process.arch.includes('64') ? 'x64' : 'x86';

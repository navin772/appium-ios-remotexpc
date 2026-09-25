import {asDictionary} from '../../../lib/remote-xpc/xpc-value.js';
import type {XPCDictionary} from '../../../lib/types.js';

/** A cryptexd routine failed: the reply carried a `cferr` or a non-zero Darwin errno. */
export class CryptexdError extends Error {
  readonly routine: string;
  readonly code?: number;
  readonly domain?: string;

  constructor(routine: string, message: string, details: {code?: number; domain?: string} = {}) {
    super(`${routine} failed: ${message}`);
    this.name = 'CryptexdError';
    this.routine = routine;
    this.code = details.code;
    this.domain = details.domain;
  }

  /** Builds the error from a `cferr` dictionary, including its chain of underlying errors. */
  static fromCferr(routine: string, cferr: XPCDictionary): CryptexdError {
    const reasons: string[] = [];
    let error: XPCDictionary | undefined = cferr;
    while (error) {
      const userInfo = asDictionary(error.cferr_userinfo);
      const description = userInfo?.NSLocalizedDescription ?? 'unknown error';
      reasons.push(`${description} (${error.cferr_domain}: ${error.cferr_code})`);
      error = asDictionary(userInfo?.underlying_cferr);
    }
    return new CryptexdError(routine, reasons.join(' <- '), {
      code: typeof cferr.cferr_code === 'number' ? cferr.cferr_code : undefined,
      domain: typeof cferr.cferr_domain === 'string' ? cferr.cferr_domain : undefined,
    });
  }
}

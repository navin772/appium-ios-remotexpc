import { getLogger } from '../../../../lib/logger.js';
import { parseBinaryPlist } from '../../../../lib/plist/index.js';
import type {
  CPUUsage,
  ProcessSnapshot,
  SysmontapConfig,
  SysmontapEvent,
  SystemSnapshot,
} from '../../../../lib/types.js';
import { MessageAux } from '../dtx-message.js';
import type { DVTSecureSocketProxyService } from '../index.js';
import { BaseInstrument } from './base-instrument.js';
import { DeviceInfo } from './device-info.js';

const log = getLogger('Sysmontap');

/** Default update rate in milliseconds */
const DEFAULT_UPDATE_RATE_MS = 500;

/** Default sample interval in milliseconds */
const DEFAULT_SAMPLE_INTERVAL_MS = 500;

/** Nanoseconds per millisecond */
const NS_PER_MS = 1_000_000;

/**
 * Sysmontap provides real-time system and process monitoring on iOS devices.
 *
 * This instrument captures:
 * - System-wide statistics (CPU, memory, network, disk I/O)
 * - Per-process metrics (CPU usage, memory footprint, thread counts, etc.)
 *
 * The instrument uses the DTTapAuthorizedAPI protocol to configure and stream
 * monitoring data from the device at configurable intervals.
 *
 * Based on `com.apple.instruments.server.services.sysmontap` from Apple's
 * Instruments framework, ported from pymobiledevice3's Sysmontap implementation.
 *
 * @example
 * ```typescript
 * // One-shot system snapshot
 * const system = await sysmontap.getSystemSnapshot();
 * console.log(`CPU Load: ${system.cpu.totalLoad}%`);
 * console.log(`Memory: ${system.system.physMemSize} pages`);
 *
 * // One-shot process snapshot
 * const processes = await sysmontap.getProcessSnapshot();
 * for (const proc of processes) {
 *   console.log(`${proc.name} (PID ${proc.pid}): CPU ${proc.cpuUsage}%`);
 * }
 *
 * // Continuous monitoring
 * for await (const event of sysmontap.events()) {
 *   if (event.type === 'system') {
 *     console.log('System stats:', event.system);
 *   } else {
 *     console.log(`${event.processes.length} processes`);
 *   }
 * }
 * ```
 */
export class Sysmontap extends BaseInstrument {
  static readonly IDENTIFIER =
    'com.apple.instruments.server.services.sysmontap';

  private processAttributes: string[] = [];
  private systemAttributes: string[] = [];
  private readonly deviceInfo: DeviceInfo;
  private isStarted: boolean = false;

  constructor(dvt: DVTSecureSocketProxyService) {
    super(dvt);
    this.deviceInfo = new DeviceInfo(dvt);
  }

  /**
   * Start the sysmontap monitoring tap.
   *
   * Queries the device for available process/system attributes, creates
   * the instrument channel, configures monitoring parameters, and begins
   * data streaming.
   *
   * @param config - Optional monitoring configuration
   */
  async start(config?: SysmontapConfig): Promise<void> {
    if (this.isStarted) {
      return;
    }

    // Query available attributes from the device
    this.processAttributes = await this.deviceInfo.sysmonProcessAttributes();
    this.systemAttributes = await this.deviceInfo.sysmonSystemAttributes();

    log.debug(
      `Device reports ${this.processAttributes.length} process attributes, ${this.systemAttributes.length} system attributes`,
    );

    // Create the sysmontap channel
    await this.initialize();

    // Build tap configuration
    const updateRateMs = config?.updateRateMs ?? DEFAULT_UPDATE_RATE_MS;
    const sampleIntervalMs =
      config?.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;

    const tapConfig = {
      ur: updateRateMs,
      bm: 0,
      procAttrs: this.processAttributes,
      sysAttrs: this.systemAttributes,
      cpuUsage: true,
      physFootprint: true,
      sampleInterval: sampleIntervalMs * NS_PER_MS,
    };

    // Configure and start the tap (fire-and-forget, no reply expected).
    // setConfig: uses NSSecureCoding, requiring proper NSDictionary/NSArray
    // class metadata in the NSKeyedArchiver encoding.
    await this.channel!.call('setConfig_')(
      new MessageAux().appendComplexObj(tapConfig),
      false,
    );
    await this.channel!.call('start')(undefined, false);

    // Consume the initial ACK/status message and validate it.
    // The device may respond with an NSError if the config was rejected.
    const ack = await this.channel!.receivePlist();
    this.validateAck(ack);

    this.isStarted = true;
    log.debug('Sysmontap monitoring started');
  }

  /**
   * Stop the sysmontap monitoring tap and release resources.
   */
  async stop(): Promise<void> {
    if (!this.isStarted || !this.channel) {
      return;
    }

    try {
      await this.channel.call('stop')(undefined, false);
    } catch (error) {
      log.debug('Error stopping sysmontap:', error);
    }

    this.isStarted = false;
    log.debug('Sysmontap monitoring stopped');
  }

  /**
   * Get a one-shot snapshot of system-wide statistics.
   *
   * Starts the tap, collects system data (skipping the first CPU usage sample
   * which is known to be uninitialized), then stops the tap.
   *
   * @param config - Optional monitoring configuration
   * @returns System snapshot containing system metrics and CPU usage
   *
   * @example
   * ```typescript
   * const snapshot = await sysmontap.getSystemSnapshot();
   * console.log(`CPU Load: ${snapshot.cpu.totalLoad}%`);
   * console.log(`CPU Count: ${snapshot.cpu.cpuCount}`);
   * console.log(`Net In: ${snapshot.system.netBytesIn} bytes`);
   * console.log(`Disk Read: ${snapshot.system.diskBytesRead} bytes`);
   * ```
   */
  async getSystemSnapshot(config?: SysmontapConfig): Promise<SystemSnapshot> {
    let cpuUsage: CPUUsage | null = null;
    let systemData: Record<string, number> | null = null;
    let isFirstCpuSample = true;

    for await (const event of this.events(config)) {
      if (event.type !== 'system') {
        continue;
      }

      if (event.cpu) {
        if (isFirstCpuSample) {
          // Skip first CPU sample (values are uninitialized)
          isFirstCpuSample = false;
          continue;
        }
        cpuUsage = event.cpu;
      }

      if (Object.keys(event.system).length > 0) {
        systemData = event.system;
      }

      if (cpuUsage && systemData) {
        break;
      }
    }

    return {
      system: systemData ?? {},
      cpu: cpuUsage ?? {
        niceLoad: 0,
        systemLoad: 0,
        totalLoad: 0,
        userLoad: 0,
        cpuCount: 0,
        enabledCPUs: 0,
      },
    };
  }

  /**
   * Get a one-shot snapshot of all running processes with their metrics.
   *
   * Starts the tap, waits for process data (skipping the first sample where
   * CPU usage values are uninitialized), then stops the tap.
   *
   * @param config - Optional monitoring configuration
   * @returns Array of process snapshots with per-process metrics
   *
   * @example
   * ```typescript
   * const processes = await sysmontap.getProcessSnapshot();
   *
   * // Find processes using significant CPU
   * const highCpu = processes.filter(p => p.cpuUsage > 5);
   * for (const proc of highCpu) {
   *   console.log(`${proc.name} (PID ${proc.pid}): ${proc.cpuUsage}% CPU`);
   * }
   *
   * // Sort by memory usage
   * const byMemory = [...processes].sort((a, b) => b.physFootprint - a.physFootprint);
   * console.log(`Top memory: ${byMemory[0].name} (${byMemory[0].physFootprint} bytes)`);
   * ```
   */
  async getProcessSnapshot(
    config?: SysmontapConfig,
  ): Promise<ProcessSnapshot[]> {
    let isFirstSample = true;

    for await (const event of this.events(config)) {
      if (event.type !== 'processes') {
        continue;
      }

      if (isFirstSample) {
        // Skip first sample (CPU usage values are uninitialized)
        isFirstSample = false;
        continue;
      }

      return event.processes;
    }

    return [];
  }

  /**
   * Async generator that yields system and process monitoring events.
   *
   * Each event is either a system statistics update or a process list update.
   * The generator automatically starts the tap when iteration begins and
   * stops it when iteration ends (via break, return, or error).
   *
   * @param config - Optional monitoring configuration
   * @yields SysmontapEvent - System or process monitoring events
   *
   * @example
   * ```typescript
   * for await (const event of sysmontap.events()) {
   *   if (event.type === 'system') {
   *     console.log(`Thread count: ${event.system.threadCount}`);
   *     if (event.cpu) {
   *       console.log(`CPU: ${event.cpu.totalLoad}%`);
   *     }
   *   } else {
   *     for (const proc of event.processes) {
   *       if (proc.cpuUsage > 10) {
   *         console.log(`High CPU: ${proc.name} at ${proc.cpuUsage}%`);
   *       }
   *     }
   *   }
   * }
   * ```
   */
  async *events(
    config?: SysmontapConfig,
  ): AsyncGenerator<SysmontapEvent, void, unknown> {
    await this.start(config);

    let messageCount = 0;
    let eventCount = 0;

    try {
      while (true) {
        const [data, aux] = await this.channel!.receivePlistWithAux();
        messageCount++;

        // Log first few messages for diagnostics
        if (messageCount <= 3) {
          log.debug(
            `Message ${messageCount}: data=${data === null ? 'null' : typeof data}` +
              ` (keys: ${data && typeof data === 'object' ? Object.keys(data).join(',') : 'N/A'})` +
              `, aux=${Array.isArray(aux) ? aux.length + ' items' : 'none'}`,
          );
        }

        // Try object data first, then fall back to auxiliary data
        const rawData = data ?? (aux.length > 0 ? aux[0] : null);
        if (!rawData) {
          continue;
        }

        // Unwrap and parse the received data into individual messages
        const messages = this.unwrapTapMessages(rawData);

        if (messages.length === 0 && messageCount <= 5) {
          log.debug(
            `Message ${messageCount} produced 0 unwrapped messages from data type: ${Array.isArray(rawData) ? 'array' : typeof rawData}`,
          );
        }

        for (const msg of messages) {
          const events = this.parseRawMessage(msg);
          if (events.length === 0 && messageCount <= 5) {
            const msgKeys = Object.keys(msg).slice(0, 10).join(',');
            log.debug(
              `Message ${messageCount} dict with keys [${msgKeys}] produced 0 events`,
            );
          }
          for (const event of events) {
            eventCount++;
            yield event;
          }
        }
      }
    } finally {
      log.debug(
        `Events stream ended: ${messageCount} messages received, ${eventCount} events yielded`,
      );
      await this.stop();
    }
  }

  /**
   * Validate the ACK message received after starting the tap.
   *
   * The device may send back an NSError if the configuration was rejected
   * (e.g., invalid NSSecureCoding). We check for error indicators and throw
   * a descriptive error rather than silently hanging.
   */
  private validateAck(ack: unknown): void {
    if (!ack) {
      // null/undefined ACK is normal (empty acknowledgment)
      return;
    }

    // Check for error strings in the response
    if (typeof ack === 'string') {
      if (ack.includes('Error')) {
        throw new Error(`Sysmontap start failed: ${ack}`);
      }
      return;
    }

    if (typeof ack !== 'object') {
      return;
    }

    const ackObj = ack as Record<string, unknown>;

    // Check for NSError indicators
    if ('NSCode' in ackObj || 'NSDomain' in ackObj || 'NSUserInfo' in ackObj) {
      const code = ackObj.NSCode ?? 'unknown';
      const domain = ackObj.NSDomain ?? 'unknown';
      const userInfo = ackObj.NSUserInfo;
      const description =
        typeof userInfo === 'object' && userInfo !== null
          ? ((userInfo as Record<string, unknown>).NSLocalizedDescription ?? '')
          : '';
      throw new Error(
        `Sysmontap setConfig rejected by device: domain=${domain} code=${code} ${description}`,
      );
    }

    log.debug('Sysmontap ACK received');
  }

  /**
   * Unwrap DTTapMessage data into parseable message objects.
   *
   * Sysmontap data arrives as DTSysmonTapMessage objects encoded via
   * NSKeyedArchiver. After decoding, the payload may appear in several forms:
   *
   * 1. `{ DTTapMessagePlist: Buffer }` - binary plist needing decode
   * 2. `{ DTTapMessagePlist: { "NS.data": Buffer } }` - NSData-wrapped binary plist
   * 3. `{ DTTapMessagePlist: [...] }` - already-decoded array of sample dicts
   * 4. `{ DTTapMessagePlist: {...} }` - already-decoded single sample dict
   * 5. Direct dict with System/Processes keys (no DTTapMessagePlist wrapper)
   * 6. Array of any of the above
   *
   * This method normalizes all forms into a flat array of sample dictionaries.
   */
  private unwrapTapMessages(data: unknown): Record<string, unknown>[] {
    if (!data || typeof data !== 'object') {
      return [];
    }

    // Handle array of messages
    if (Array.isArray(data)) {
      return data.flatMap((item) => this.unwrapTapMessages(item));
    }

    const obj = data as Record<string, unknown>;

    // DTSysmonTapMessage wraps its payload in DTTapMessagePlist
    if ('DTTapMessagePlist' in obj) {
      return this.extractFromDTTapMessagePlist(obj.DTTapMessagePlist);
    }

    // Direct message (already has Processes/System/etc. keys)
    return [obj];
  }

  /**
   * Extract monitoring data from the DTTapMessagePlist value.
   *
   * The plist data may be raw binary (Buffer), NSData-wrapped
   * (`{ "NS.data": Buffer }`), or already decoded (dict/array).
   */
  private extractFromDTTapMessagePlist(
    plistData: unknown,
  ): Record<string, unknown>[] {
    // Case 1: Raw binary plist data (Buffer or Uint8Array)
    const rawBuffer = this.extractRawBuffer(plistData);
    if (rawBuffer) {
      log.debug(`DTTapMessagePlist is binary data (${rawBuffer.length} bytes)`);
      return this.decodeBinaryPlistMessages(rawBuffer);
    }

    // Case 2: Already-decoded array of sample dictionaries
    if (Array.isArray(plistData)) {
      log.debug(`DTTapMessagePlist is array with ${plistData.length} elements`);
      return plistData.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object' && !Array.isArray(item),
      );
    }

    // Case 3: Already-decoded single sample dictionary
    if (typeof plistData === 'object' && plistData !== null) {
      const obj = plistData as Record<string, unknown>;
      const keys = Object.keys(obj);
      log.debug(`DTTapMessagePlist is object with keys: ${keys.join(',')}`);

      // DTSysmonTapMessage may encode its payload under a short key like "k".
      // If the value under "k" is binary plist data, decode it.
      if (keys.includes('k')) {
        const kValue = obj.k;
        log.debug(
          `DTTapMessagePlist.k type=${typeof kValue}, isBuffer=${Buffer.isBuffer(kValue)}, isArray=${Array.isArray(kValue)}, val=${typeof kValue === 'number' || typeof kValue === 'string' ? kValue : JSON.stringify(kValue)?.slice(0, 200)}`,
        );
        const kBuffer = this.extractRawBuffer(kValue);
        if (kBuffer) {
          log.debug(
            `DTTapMessagePlist.k is binary data (${kBuffer.length} bytes)`,
          );
          return this.decodeBinaryPlistMessages(kBuffer);
        }
      }

      return [obj];
    }

    log.debug('Unexpected DTTapMessagePlist type:', typeof plistData);
    return [];
  }

  /**
   * Extract a raw Buffer from potentially NSData-wrapped values.
   *
   * NSData objects decoded by our NSKeyedArchiver decoder appear as
   * `{ "NS.data": Buffer }`. This method handles both direct Buffers
   * and NSData-wrapped Buffers.
   */
  private extractRawBuffer(value: unknown): Buffer | null {
    // Direct Buffer
    if (Buffer.isBuffer(value)) {
      return value;
    }
    if (value instanceof Uint8Array) {
      return Buffer.from(value);
    }

    // NSData wrapper: { "NS.data": Buffer }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if ('NS.data' in obj) {
        const nsData = obj['NS.data'];
        if (Buffer.isBuffer(nsData)) {
          return nsData;
        }
        if (nsData instanceof Uint8Array) {
          return Buffer.from(nsData);
        }
      }
    }

    return null;
  }

  /**
   * Decode a binary plist buffer into monitoring message dictionaries.
   */
  private decodeBinaryPlistMessages(buf: Buffer): Record<string, unknown>[] {
    try {
      const decoded = parseBinaryPlist(buf);

      if (Array.isArray(decoded)) {
        return (decoded as unknown[]).filter(
          (item): item is Record<string, unknown> =>
            item !== null && typeof item === 'object' && !Array.isArray(item),
        );
      }

      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
        return [decoded as Record<string, unknown>];
      }
    } catch (error) {
      log.warn('Failed to decode DTTapMessagePlist binary data:', error);
    }

    return [];
  }

  /**
   * Parse a raw sysmontap message into typed events.
   *
   * A single raw message may contain both system and process data,
   * so this returns an array of parsed events.
   */
  private parseRawMessage(raw: Record<string, unknown>): SysmontapEvent[] {
    const events: SysmontapEvent[] = [];

    // Parse system data
    if ('System' in raw || 'SystemCPUUsage' in raw) {
      const systemEvent: SysmontapEvent = {
        type: 'system',
        system: this.parseSystemAttributes(raw.System),
      };

      if ('SystemCPUUsage' in raw || 'CPUCount' in raw) {
        systemEvent.cpu = this.parseCPUUsage(raw);
      }

      events.push(systemEvent);
    }

    // Parse process data
    if ('Processes' in raw) {
      const processesRaw = raw.Processes;
      if (processesRaw && typeof processesRaw === 'object') {
        const keys = Object.keys(processesRaw as object);
        if (keys.length > 0) {
          const firstKey = keys[0];
          const firstVal = (processesRaw as Record<string, unknown>)[firstKey];
          log.debug(
            `Processes: ${keys.length} entries, firstKey="${firstKey}" (type=${typeof firstKey}), firstVal type=${typeof firstVal}, isArray=${Array.isArray(firstVal)}`,
          );
          if (Array.isArray(firstVal)) {
            log.debug(
              `Processes firstVal: len=${firstVal.length}, [0] type=${typeof firstVal[0]}, isArray[0]=${Array.isArray(firstVal[0])}`,
            );
          }
        } else {
          log.debug('Processes dict is empty');
        }
      } else {
        log.debug(
          `Processes value is ${typeof processesRaw}: ${String(processesRaw)}`,
        );
      }
      const processes = this.parseProcesses(
        raw.Processes as Record<string, unknown[]>,
      );
      if (processes.length > 0) {
        events.push({
          type: 'processes',
          processes,
        });
      }
    }

    return events;
  }

  /**
   * Parse system attribute values using the attribute name mapping
   * from the device.
   */
  private parseSystemAttributes(systemData: unknown): Record<string, number> {
    if (!Array.isArray(systemData)) {
      return {};
    }

    const result: Record<string, number> = {};
    for (
      let i = 0;
      i < this.systemAttributes.length && i < systemData.length;
      i++
    ) {
      const value = systemData[i];
      if (typeof value === 'number') {
        result[this.systemAttributes[i]] = value;
      }
    }

    return result;
  }

  /**
   * Parse CPU usage data from the raw message.
   */
  private parseCPUUsage(raw: Record<string, unknown>): CPUUsage {
    const cpuUsageData = (raw.SystemCPUUsage ?? {}) as Record<string, number>;

    return {
      niceLoad: cpuUsageData.CPU_NiceLoad ?? 0,
      systemLoad: cpuUsageData.CPU_SystemLoad ?? 0,
      totalLoad: cpuUsageData.CPU_TotalLoad ?? 0,
      userLoad: cpuUsageData.CPU_UserLoad ?? 0,
      cpuCount: (raw.CPUCount as number) ?? 0,
      enabledCPUs: (raw.EnabledCPUs as number) ?? 0,
    };
  }

  /**
   * Parse process data from the Processes dictionary.
   *
   * The device sends processes as a dictionary mapping PID to an array
   * of attribute values. The array order matches the processAttributes
   * array queried during initialization.
   */
  private parseProcesses(
    processesDict: Record<string, unknown[]> | null | undefined,
  ): ProcessSnapshot[] {
    if (!processesDict || typeof processesDict !== 'object') {
      return [];
    }

    const entries: ProcessSnapshot[] = [];

    for (const [, processValues] of Object.entries(processesDict)) {
      if (!Array.isArray(processValues)) {
        continue;
      }

      const entry: Record<string, unknown> = {};
      for (
        let i = 0;
        i < this.processAttributes.length && i < processValues.length;
        i++
      ) {
        entry[this.processAttributes[i]] = processValues[i];
      }

      entries.push({
        pid: (entry.pid as number) ?? -1,
        name: (entry.name as string) ?? '',
        cpuUsage: (entry.cpuUsage as number) ?? 0,
        physFootprint: (entry.physFootprint as number) ?? 0,
        ...entry,
      });
    }

    return entries;
  }
}

import assert from 'node:assert/strict';
import {type TestContext, describe, it} from 'node:test';

import type {PlistDictionary} from '../../../src/lib/types.js';
import {MobileImageMounterService} from '../../../src/services/ios/mobile-image-mounter/index.js';

/** Stubs the private `sendRequest` so each command gets its canned reply. */
function stubReplies(
  t: TestContext,
  replies: Record<string, PlistDictionary | Error>,
): {commands: string[]; service: MobileImageMounterService} {
  const service = new MobileImageMounterService('phone-udid');
  const commands: string[] = [];
  t.mock.method(service as any, 'sendRequest', async (request: PlistDictionary) => {
    const command = String(request.Command);
    commands.push(command);
    const reply = replies[command];
    if (reply instanceof Error) {
      throw reply;
    }
    return reply ?? {};
  });
  return {commands, service};
}

describe('MobileImageMounterService.isPersonalizedImageMounted', () => {
  it('trusts a non-empty LookupImage signature without asking CopyDevices', async (t) => {
    const {commands, service} = stubReplies(t, {
      LookupImage: {Status: 'Complete', ImageSignature: [Buffer.from('sig')]},
    });
    assert.equal(await service.isPersonalizedImageMounted(), true);
    assert.deepEqual(commands, ['LookupImage']);
  });

  it('falls back to CopyDevices when LookupImage returns an empty signature', async (t) => {
    const {commands, service} = stubReplies(t, {
      LookupImage: {Status: 'Complete', ImageSignature: []},
      CopyDevices: {EntryList: [{DiskImageType: 'Personalized', MountPath: '/System/Developer'}]},
    });
    assert.equal(await service.isPersonalizedImageMounted(), true);
    assert.deepEqual(commands, ['LookupImage', 'CopyDevices']);
  });

  it('is false when neither LookupImage nor CopyDevices reports a personalized image', async (t) => {
    const {service} = stubReplies(t, {
      LookupImage: {Status: 'Complete'},
      CopyDevices: {EntryList: [{DiskImageType: 'Developer'}]},
    });
    assert.equal(await service.isPersonalizedImageMounted(), false);
  });

  it('is false when CopyDevices fails', async (t) => {
    const {service} = stubReplies(t, {
      LookupImage: {Status: 'Complete', ImageSignature: []},
      CopyDevices: new Error('UnknownCommand'),
    });
    assert.equal(await service.isPersonalizedImageMounted(), false);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OtrWorkerController } from './otrWorker';

describe('OTR worker lifecycle', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('isolates a worker per active profile and terminates it', () => {
    const terminate = vi.fn(); const postMessage = vi.fn();
    const WorkerMock = vi.fn(function WorkerMock() { return { terminate, postMessage }; });
    vi.stubGlobal('Worker', WorkerMock);
    const controller = new OtrWorkerController();
    controller.start('profile-a');
    expect(postMessage).toHaveBeenCalledWith({ type: 'initialize', profileId: 'profile-a' });
    controller.start('profile-b');
    expect(terminate).toHaveBeenCalledOnce();
    controller.stop();
    expect(terminate).toHaveBeenCalledTimes(2);
    expect(controller.isRunning).toBe(false);
  });
});

type OtrWorkerCommand =
  | { type: 'initialize'; profileId: string }
  | { type: 'shutdown' };

let activeProfileId: string | undefined;

self.addEventListener('message', (event: MessageEvent<OtrWorkerCommand>) => {
  if (event.data.type === 'initialize') {
    activeProfileId = event.data.profileId;
    self.postMessage({ type: 'status', state: 'unavailable', profileId: activeProfileId, reason: 'libotr WASM is not bundled' });
  } else {
    activeProfileId = undefined;
    self.close();
  }
});

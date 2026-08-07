export class Worker {
  constructor() {
    throw new Error('Nested Node workers are unavailable in the browser');
  }
}

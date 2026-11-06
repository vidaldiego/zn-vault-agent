import { prepareKeyObservation, type KeyBindingObservation, type KeyPreparation } from '../../lib/key-rotation-propagation.js';

export interface TrackedKeySynchronizerOptions {
  keyNames: string[];
  observeKey: (name: string, isCancelled: () => boolean, onStaged?: () => void) => Promise<KeyBindingObservation>;
  isShuttingDown?: () => boolean;
}

/** Initial/explicit reads share ordered preparation and separately owned ACKs. */
export class TrackedKeySynchronizer {
  private preparation: KeyPreparation<void> | null = null;
  private stopped = false;
  constructor(private readonly options: TrackedKeySynchronizerOptions) {}

  synchronize(): Promise<void> { return this.prepareInitial().completed; }

  prepareInitial(): KeyPreparation<void> {
    if (this.preparation) return this.preparation;
    const isCancelled = (): boolean => this.stopped || this.options.isShuttingDown?.() === true;
    const observations = [...new Set(this.options.keyNames)].map(name => prepareKeyObservation(async onStaged => {
      if (isCancelled()) throw new Error('Key synchronization is stopped');
      const observation = await this.options.observeKey(name, isCancelled, onStaged);
      if (isCancelled() || !observation.response || observation.propagation.errors.length > 0) {
        throw new Error(`Key '${name}' synchronization incomplete or superseded`);
      }
    }));
    const prepared = Promise.all(observations.map(observation => observation.prepared)).then(() => undefined);
    const completed = Promise.allSettled(observations.map(observation => observation.completed)).then(results => {
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
      if (errors.length > 0) throw new AggregateError(errors, 'Tracked key synchronization incomplete');
    }).finally(() => { if (this.preparation?.completed === completed) this.preparation = null; });
    void prepared.catch(() => undefined);
    void completed.catch(() => undefined);
    this.preparation = { prepared, completed };
    return this.preparation;
  }

  stop(): void { this.stopped = true; }
}

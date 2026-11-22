/** A minimal typed event emitter (no platform dependencies). */
export class Emitter<Events extends object> {
  #handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void {
    let set = this.#handlers.get(event);
    if (!set) this.#handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const h of this.#handlers.get(event) ?? []) (h as (p: Events[K]) => void)(payload);
  }
}

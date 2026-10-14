/**
 * IntersectionObserver double that follows the real delivery rules:
 *  - observe() on an already-observed target is a no-op (no count, no new notification);
 *  - a newly observed target (first observe, or observe after unobserve) queues ONE
 *    initial notification reporting its current visibility, delivered by flush();
 *  - later notifications only happen on changes, which a test simulates with fire().
 * `visible` is the sentinel's current on-screen state, used by flush().
 */
export class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  observed = new Set<Element>();
  observeCalls = 0;
  visible = false;
  private pendingInitial = new Set<Element>();
  disconnected = false;
  constructor(private cb: IntersectionObserverCallback, public options?: IntersectionObserverInit) {
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    if (this.observed.has(el)) return; // real IO ignores a repeat observe(): no new initial notification
    this.observed.add(el);
    this.pendingInitial.add(el);
    this.observeCalls += 1;
  }
  unobserve(el: Element) { this.observed.delete(el); this.pendingInitial.delete(el); }
  disconnect() { this.observed.clear(); this.pendingInitial.clear(); this.disconnected = true; }
  takeRecords() { return []; }
  fire(isIntersecting = true) {
    const entries = [...this.observed].map((target) => ({ isIntersecting, target })) as unknown as IntersectionObserverEntry[];
    this.cb(entries, this as unknown as IntersectionObserver);
  }
  /** Deliver the queued initial notifications (one per newly observed target) with the current `visible` state. */
  flush() {
    const targets = [...this.pendingInitial].filter((t) => this.observed.has(t));
    this.pendingInitial.clear();
    if (targets.length === 0) return;
    const entries = targets.map((target) => ({ isIntersecting: this.visible, target })) as unknown as IntersectionObserverEntry[];
    this.cb(entries, this as unknown as IntersectionObserver);
  }
  static latest(): MockIntersectionObserver {
    return MockIntersectionObserver.instances[MockIntersectionObserver.instances.length - 1];
  }
  static reset() { MockIntersectionObserver.instances = []; }
}

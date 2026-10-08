/** Minimal IntersectionObserver double: records observe() calls and lets a test fire entries. */
export class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  observed = new Set<Element>();
  observeCalls = 0;
  disconnected = false;
  constructor(private cb: IntersectionObserverCallback, public options?: IntersectionObserverInit) {
    MockIntersectionObserver.instances.push(this);
  }
  observe(el: Element) { this.observed.add(el); this.observeCalls += 1; }
  unobserve(el: Element) { this.observed.delete(el); }
  disconnect() { this.observed.clear(); this.disconnected = true; }
  takeRecords() { return []; }
  fire(isIntersecting = true) {
    const entries = [...this.observed].map((target) => ({ isIntersecting, target })) as unknown as IntersectionObserverEntry[];
    this.cb(entries, this as unknown as IntersectionObserver);
  }
  static latest(): MockIntersectionObserver {
    return MockIntersectionObserver.instances[MockIntersectionObserver.instances.length - 1];
  }
  static reset() { MockIntersectionObserver.instances = []; }
}

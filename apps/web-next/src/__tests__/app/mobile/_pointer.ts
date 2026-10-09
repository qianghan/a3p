/** jsdom 24 has no PointerEvent: fireEvent.pointerDown falls back to a bare
 *  Event and silently drops clientX/pointerId. MouseEvent keeps coordinates. */
export function installPointerEvent(): void {
  if (typeof window.PointerEvent === 'function') return;
  class FakePointerEvent extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'touch';
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = FakePointerEvent;
}

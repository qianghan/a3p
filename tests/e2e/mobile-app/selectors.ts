/**
 * The e2e selector contract for the /app PWA. Every id here is asserted to exist
 * in apps/web-next/src/app/app/** by
 * apps/web-next/src/__tests__/architecture/mobile-app-selectors.test.ts, so a
 * renamed testid fails CI instead of turning a launch gate into a silent timeout.
 */
export const SEL = {
  shell: { tabbar: 'tabbar', tabHome: 'tab-home', tabDocs: 'tab-docs', tabCapture: 'tab-capture', tabChat: 'tab-chat' },
  home: {
    screen: 'home-screen', skeleton: 'home-skeleton', error: 'home-error', stale: 'stale-notice', empty: 'home-empty',
    alertBanner: 'alert-carousel', alertAction: 'home-alert-action',
    kpiMonthNet: 'home-kpi-month-net', kpiCash: 'home-kpi-cash', kpiOutstanding: 'home-kpi-outstanding', kpiTax: 'home-kpi-tax',
    kpiSheet: 'home-kpi-sheet',
  },
  docs: {
    screen: 'docs-screen', skeleton: 'docs-skeleton', error: 'docs-error', stale: 'docs-stale', empty: 'docs-empty',
    row: 'doc-item', search: 'docs-search', filterPrefix: 'docs-filter-',
  },
  viewer: {
    screen: 'doc-viewer', skeleton: 'doc-skeleton', error: 'doc-viewer-error',
    vendor: 'doc-viewer-vendor', amount: 'doc-amount', archive: 'doc-archive', restore: 'doc-restore',
  },
  capture: {
    screen: 'capture-screen', fileInput: 'capture-file', amount: 'capture-amount', save: 'capture-save',
    error: 'capture-error', queuePill: 'queue-pill',
  },
  chat: {
    screen: 'chat-screen', loading: 'chat-history-loading', error: 'chat-history-error', empty: 'chat-empty',
    offline: 'chat-offline', input: 'chat-input', send: 'chat-send', botBubble: 'chat-bubble-bot',
    userBubble: 'chat-bubble-user', typing: 'chat-typing',
  },
} as const;

/** Where each id lives — what to annotate if the inventory guard reports it missing. */
export const SEL_ELEMENTS: Record<string, string> = {
  'tabbar': 'the bottom <nav> of the shell',
  'tab-home': 'Home tab link', 'tab-docs': 'Docs tab link', 'tab-capture': 'raised Capture button', 'tab-chat': 'Chat tab link',
  'home-screen': 'Home page root', 'home-skeleton': 'Home loading skeleton', 'home-error': 'Home error state (contains Retry)',
  'stale-notice': 'Home "as of HH:MM" offline/stale label (HomeStates StaleNotice)', 'home-empty': 'Home brand-new empty state',
  'alert-carousel': 'alert banner card (AlertCarousel)', 'home-alert-action': 'the banner card action button/link',
  'home-kpi-month-net': 'month-to-date net tile', 'home-kpi-cash': 'cash today tile',
  'home-kpi-outstanding': 'outstanding invoices tile', 'home-kpi-tax': 'estimated tax tile',
  'home-kpi-sheet': 'KPI breakdown sheet',
  'docs-screen': 'Docs page root', 'docs-skeleton': 'Docs loading skeleton', 'docs-error': 'Docs error state (contains Retry)',
  'docs-stale': 'Docs offline/stale label', 'docs-empty': 'Docs empty state', 'doc-item': 'each list/grid item (a link to /app/docs/[id])',
  'docs-search': 'search input', 'docs-filter-': 'each filter chip as `docs-filter-${filter}` with aria-pressed',
  'doc-viewer': 'viewer root', 'doc-skeleton': 'viewer loading state', 'doc-viewer-error': 'viewer error / not found state',
  'doc-viewer-vendor': 'vendor field (input)', 'doc-amount': 'amount (text)',
  'doc-archive': 'Archive button', 'doc-restore': 'Restore button',
  'capture-screen': 'Capture page root', 'capture-file': 'the photo <input type=file>', 'capture-amount': 'amount input',
  'capture-save': 'Save button', 'capture-error': 'capture error message', 'queue-pill': '"Queued · N waiting" pill',
};

export const ALL_SELECTOR_IDS: string[] = Object.values(SEL).flatMap((group) => Object.values(group));

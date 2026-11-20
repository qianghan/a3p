/** Add-employee form starts in the TENANT's market and sends it (never a silent 'us'). */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PayrollPage from '@/app/(dashboard)/payroll/page';

const ok = (data: unknown) => Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(data) });

describe('Payroll add-employee form', () => {
  it.each([['au', 'NSW'], ['ca', 'ON']])('%s tenant: select preselected and POST carries it', async (j, region) => {
    const posts: Array<Record<string, unknown>> = [];
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.endsWith('/employees')) { posts.push(JSON.parse(String(init.body))); return ok({ success: true, data: {} }); }
      if (url.includes('tenant-config')) return ok({ success: true, data: { jurisdiction: j, region, currency: 'USD', locale: 'en-US' } });
      return ok({ success: true, data: url.includes('year-end') ? { forms: [] } : [] });
    }) as unknown as typeof fetch;
    render(<PayrollPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^employee$/i }));
    const sel = (await screen.findAllByRole('combobox')).find((s) => (s as HTMLSelectElement).value === j) as HTMLSelectElement;
    expect(sel).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: 'Pat' } });
    fireEvent.change(screen.getByPlaceholderText(/annual salary/i), { target: { value: '50000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].jurisdiction).toBe(j);
  });
});

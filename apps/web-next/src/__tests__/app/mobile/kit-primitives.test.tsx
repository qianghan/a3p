import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { Button } from '@/app/app/_kit/Button';
import { Card, cardStyle } from '@/app/app/_kit/Card';
import { Chip, chipStyle } from '@/app/app/_kit/Chip';
import { Pill, pillStyle } from '@/app/app/_kit/Pill';
import { Skeleton } from '@/app/app/_kit/Skeleton';
import { EmptyState } from '@/app/app/_kit/EmptyState';
import { Thumb, isOptimizableHost, isPdfUrl } from '@/app/app/_kit/Thumb';
import { tokens } from '@/app/app/_kit/tokens';
import { renderWithI18n, expectTokenOnly, expectTouchTarget } from './test-utils';

describe('Button', () => {
  it('is a 44px button that fires onClick and defaults to type=button', () => {
    const onClick = vi.fn();
    renderWithI18n(<Button onClick={onClick}>Go</Button>);
    const btn = screen.getByRole('button', { name: 'Go' });
    expect(btn).toHaveAttribute('type', 'button');
    expectTouchTarget(btn);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire when disabled', () => {
    const onClick = vi.fn();
    renderWithI18n(<Button disabled onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Card', () => {
  it('renders children in a token-styled container and passes through attributes', () => {
    renderWithI18n(<Card data-testid="c" role="group">body</Card>);
    expect(screen.getByTestId('c')).toHaveTextContent('body');
    expect(screen.getByRole('group')).toBeInTheDocument();
    expectTokenOnly(cardStyle());
    expect(cardStyle().background).toBe(tokens.color.card);
  });
});

describe('Chip', () => {
  it('is a toggle button with aria-pressed and a 44px target', () => {
    const onClick = vi.fn();
    renderWithI18n(<Chip label="All" selected onClick={onClick} count={4} />);
    const chip = screen.getByRole('button', { name: /All/ });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(chip).toHaveTextContent('4');
    expectTouchTarget(chip);
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('selected and unselected styles are token-only and visibly different', () => {
    expectTokenOnly(chipStyle(true));
    expectTokenOnly(chipStyle(false));
    expect(chipStyle(true).background).not.toBe(chipStyle(false).background);
  });
});

describe('Pill', () => {
  it.each(['neutral', 'primary', 'good', 'warn', 'critical'] as const)('%s pill is token-only', (tone) => {
    expectTokenOnly(pillStyle(tone));
  });

  it('renders its label with the tone exposed for styling hooks', () => {
    renderWithI18n(<Pill tone="primary">AI</Pill>);
    expect(screen.getByText('AI')).toHaveAttribute('data-tone', 'primary');
  });
});

describe('Skeleton', () => {
  it('is hidden from assistive tech and sized as asked', () => {
    const { container } = renderWithI18n(<Skeleton width={120} height={20} />);
    const el = container.querySelector('[data-skeleton]') as HTMLElement;
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el.style.width).toBe('120px');
    expect(el.style.height).toBe('20px');
  });
});

describe('EmptyState', () => {
  it('renders a heading, body and actions', () => {
    renderWithI18n(
      <EmptyState title="Nothing here" body="Add something">
        <a href="/app/capture">add</a>
      </EmptyState>,
    );
    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeInTheDocument();
    expect(screen.getByText('Add something')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'add' })).toHaveAttribute('href', '/app/capture');
  });
});

describe('Thumb', () => {
  it('shows a labelled placeholder when there is no receipt', () => {
    renderWithI18n(<Thumb src={null} alt="receipt" />);
    expect(screen.getByRole('img', { name: 'No receipt image' })).toBeInTheDocument();
  });

  it('shows a PDF tile rather than trying to render a PDF as an image', () => {
    renderWithI18n(<Thumb src="https://x.public.blob.vercel-storage.com/r.pdf" alt="receipt" />);
    expect(screen.getByRole('img', { name: 'PDF receipt' })).toBeInTheDocument();
  });

  it('renders a sized, lazy image for a photo', () => {
    renderWithI18n(<Thumb src="https://x.public.blob.vercel-storage.com/r.jpg" alt="Staples receipt" size={56} />);
    const img = screen.getByAltText('Staples receipt');
    expect(img).toHaveAttribute('width', '56');
    expect(img).toHaveAttribute('height', '56');
    expect(img).toHaveAttribute('loading', 'lazy');
  });

  it('only routes Blob-hosted images through the optimizer (next.config remotePatterns)', () => {
    expect(isOptimizableHost('https://abc.public.blob.vercel-storage.com/r.jpg')).toBe(true);
    expect(isOptimizableHost('https://evil.example.com/r.jpg')).toBe(false);
    expect(isOptimizableHost('not a url')).toBe(false);
    expect(isPdfUrl('https://x/y.PDF?sig=1')).toBe(true);
    expect(isPdfUrl('https://x/y.jpg')).toBe(false);
  });
});

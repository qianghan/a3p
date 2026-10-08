import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DocThumb } from '@/app/app/docs/_components/DocThumb';

const BLOB = 'https://abcd.public.blob.vercel-storage.com/receipts/t/1-r.jpg';

describe('DocThumb', () => {
  it('renders an optimizer image with fixed dimensions (no layout shift) and lazy loading', () => {
    render(<DocThumb src={BLOB} size={48} alt="" />);
    const img = screen.getByTestId('doc-thumb');
    expect(img).toHaveAttribute('src', BLOB);
    expect(img).toHaveAttribute('width', '48');
    expect(img).toHaveAttribute('height', '48');
    expect(img).toHaveAttribute('loading', 'lazy');
  });
  it('falls back to a lazy plain <img> of the same size when the optimizer fails', () => {
    render(<DocThumb src={BLOB} size={48} alt="" />);
    fireEvent.error(screen.getByTestId('doc-thumb'));
    const fb = screen.getByTestId('doc-thumb-fallback');
    expect(fb).toHaveAttribute('src', BLOB);
    expect(fb).toHaveAttribute('loading', 'lazy');
    expect(fb).toHaveAttribute('width', '48');
    expect(fb).toHaveAttribute('height', '48');
    expect(screen.queryByTestId('doc-thumb')).toBeNull();
  });
  it('retries the optimizer when the same row is reused for a different receipt', () => {
    const OTHER = 'https://abcd.public.blob.vercel-storage.com/receipts/t/2-other.jpg';
    const { rerender } = render(<DocThumb src={BLOB} size={48} alt="" />);
    fireEvent.error(screen.getByTestId('doc-thumb'));
    expect(screen.getByTestId('doc-thumb-fallback')).toHaveAttribute('src', BLOB);
    rerender(<DocThumb src={OTHER} size={48} alt="" />);
    expect(screen.getByTestId('doc-thumb')).toHaveAttribute('src', OTHER);
    expect(screen.queryByTestId('doc-thumb-fallback')).toBeNull();
  });
  it('does not send a host the optimizer rejects through it: renders the plain lazy <img> directly', () => {
    render(<DocThumb src="https://files.example.com/r/a.jpg" size={48} alt="" />);
    expect(screen.queryByTestId('doc-thumb')).toBeNull();
    const fb = screen.getByTestId('doc-thumb-fallback');
    expect(fb).toHaveAttribute('src', 'https://files.example.com/r/a.jpg');
    expect(fb).toHaveAttribute('loading', 'lazy');
    expect(fb).toHaveAttribute('width', '48');
  });
  it('does not send an http: Blob URL through the optimizer (it rejects non-https): plain lazy <img>', () => {
    const HTTP = 'http://abcd.public.blob.vercel-storage.com/receipts/t/1-r.jpg';
    render(<DocThumb src={HTTP} size={48} alt="" />);
    expect(screen.queryByTestId('doc-thumb')).toBeNull();
    const fb = screen.getByTestId('doc-thumb-fallback');
    expect(fb).toHaveAttribute('src', HTTP);
    expect(fb).toHaveAttribute('loading', 'lazy');
  });
  it('does not send a data: URL through the optimizer', () => {
    render(<DocThumb src="data:image/png;base64,AAAA" size={48} alt="" />);
    expect(screen.queryByTestId('doc-thumb')).toBeNull();
    expect(screen.getByTestId('doc-thumb-fallback')).toBeInTheDocument();
  });
  it('passes the caller-supplied alt text through on both the optimizer and fallback image', () => {
    render(<DocThumb src={BLOB} size={32} alt="receipt preview" />);
    expect(screen.getByTestId('doc-thumb')).toHaveAttribute('alt', 'receipt preview');
    fireEvent.error(screen.getByTestId('doc-thumb'));
    expect(screen.getByTestId('doc-thumb-fallback')).toHaveAttribute('alt', 'receipt preview');
  });
  it('sizes the box and the image from the size prop', () => {
    render(<DocThumb src={BLOB} size={72} alt="" />);
    const img = screen.getByTestId('doc-thumb');
    expect(img).toHaveAttribute('width', '72');
    expect(img).toHaveAttribute('sizes', '72px');
  });
  it('renders a placeholder tile when there is no receipt', () => {
    render(<DocThumb src={null} size={48} alt="" />);
    expect(screen.getByTestId('doc-thumb-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-thumb')).toBeNull();
  });
  it('renders a PDF tile instead of asking the optimizer to rasterise a PDF', () => {
    render(<DocThumb src="https://abcd.public.blob.vercel-storage.com/r/a.pdf" size={48} alt="" />);
    expect(screen.getByTestId('doc-thumb-pdf')).toBeInTheDocument();
    expect(screen.queryByTestId('doc-thumb')).toBeNull();
  });
});

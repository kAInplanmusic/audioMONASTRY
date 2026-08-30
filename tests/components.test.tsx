// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { PluginButton } from '../src/components/PluginButton';

const DummyIcon = ({ size }: { size?: number }) => <span data-size={size}>ICON</span>;

describe('React-Komponenten (jsdom)', () => {
  it('PluginButton rendert Label und reagiert auf Klick', () => {
    const onClick = vi.fn();
    render(
      <PluginButton
        id="test-plugin"
        icon={DummyIcon as never}
        short="TEST"
        isActive={false}
        state="PRO"
        onClick={onClick}
      />,
    );
    const button = screen.getByRole('button', { name: /TEST/i });
    expect(button).toBeTruthy();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('ErrorBoundary rendert Kinder im Normalfall', () => {
    render(
      <ErrorBoundary>
        <div>INHALT_OK</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('INHALT_OK')).toBeTruthy();
  });
});

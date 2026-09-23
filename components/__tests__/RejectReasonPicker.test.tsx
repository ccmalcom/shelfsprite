/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import RejectReasonPicker from '@/components/RejectReasonPicker';

const REASONS = { too_dark: 'Too dark', wrong_vibe: 'Wrong vibe', not_now: 'Not in the mood' };

function renderPicker() {
  const onSubmit = jest.fn();
  const onCancel = jest.fn();
  render(
    <RejectReasonPicker
      labelId="pick-title"
      heading="What missed?"
      hint="Optional."
      reasons={REASONS}
      skipLabel="Skip this one"
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
  return { onSubmit, onCancel };
}

describe('RejectReasonPicker', () => {
  it('is a labelled dialog with one toggle per reason', () => {
    renderPicker();
    expect(screen.getByRole('dialog', { name: 'What missed?' })).toBeInTheDocument();
    for (const label of Object.values(REASONS)) {
      expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('submits no reasons under the skip label', () => {
    const { onSubmit } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Skip this one' }));
    expect(onSubmit).toHaveBeenCalledWith([]);
  });

  it('submits the chosen reasons in the order they were picked', () => {
    const { onSubmit } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Wrong vibe' }));
    fireEvent.click(screen.getByRole('button', { name: 'Too dark' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not in the mood' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not in the mood' }));
    expect(screen.getByRole('button', { name: 'Wrong vibe' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Skip with reason' }));
    expect(onSubmit).toHaveBeenCalledWith(['wrong_vibe', 'too_dark']);
  });

  it('cancels from the button and from Escape', () => {
    const { onCancel, onSubmit } = renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

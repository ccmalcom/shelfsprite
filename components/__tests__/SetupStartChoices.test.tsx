/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { UploadStep } from '@/components/SetupWizard';
import ImportModal from '@/components/ImportModal';
import { ToastProvider } from '@/components/ui';

jest.mock('swr', () => ({
  __esModule: true,
  default: () => ({ data: undefined, mutate: jest.fn() }),
  mutate: jest.fn(async () => undefined),
}));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));
jest.mock('@/hooks/useFeedbackPrompt', () => ({
  useFeedbackPrompt: () => ({ fire: jest.fn(), modal: null }),
}));
jest.mock('@/components/reveal/RevealSequence', () => ({ __esModule: true, default: () => null }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual('@/lib/api'),
  api: { importLibrary: jest.fn(), importPreview: jest.fn(), stats: jest.fn() },
}));

describe("setup's first choice", () => {
  it('names The StoryGraph beside Goodreads, each with where its export lives', () => {
    render(<UploadStep onDone={jest.fn()} onManual={jest.fn()} />);
    expect(
      screen.getByRole('heading', { name: 'Import from Goodreads or The StoryGraph' })
    ).toBeInTheDocument();
    // The export paths are the ones the repo already documented; nothing new is invented.
    expect(screen.getByText('The StoryGraph').nextSibling).toHaveTextContent(
      'Manage Account › Export'
    );
    expect(screen.getByText('Goodreads').nextSibling).toHaveTextContent('My Books › Import/Export');
  });

  it('offers the no-export starts and opens the one chosen', () => {
    const onManual = jest.fn();
    render(<UploadStep onDone={jest.fn()} onManual={onManual} />);
    fireEvent.click(screen.getByRole('button', { name: /Rate popular books/ }));
    fireEvent.click(screen.getByRole('button', { name: /Paste a list of titles/ }));
    fireEvent.click(screen.getByRole('button', { name: /Search and add by hand/ }));
    expect(onManual.mock.calls).toEqual([['quick'], ['paste'], ['list']]);
  });

  it('keeps em-dashes out of the new copy', () => {
    const { container } = render(<UploadStep onDone={jest.fn()} onManual={jest.fn()} />);
    expect(container.textContent).not.toMatch(/—/);
  });
});

describe('import card', () => {
  it('says StoryGraph exports are recognized automatically and where to find one', () => {
    render(
      <ToastProvider>
        <ImportModal onClose={jest.fn()} onImported={jest.fn()} />
      </ToastProvider>
    );
    expect(
      screen.getByText(/Goodreads and The StoryGraph exports are recognized automatically/)
    ).toBeInTheDocument();
    expect(screen.getByText('From The StoryGraph: Manage Account › Export.')).toBeInTheDocument();
  });
});

'use client';
import { useState } from 'react';
import { CircleHelp } from 'lucide-react';
import FeedbackModal from '@/components/FeedbackModal';

export default function FeedbackLauncher({ onOpen }: { onOpen?: () => void }) {
  const [modalOpen, setModalOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => (onOpen ? onOpen() : setModalOpen(true))}
        className="shell-link w-full"
      >
        <CircleHelp size={18} aria-hidden="true" /> Help & feedback
      </button>
      {modalOpen && (
        <FeedbackModal
          heading="What's working? What isn't?"
          onClose={() => setModalOpen(false)}
          onResolved={() => setModalOpen(false)}
        />
      )}
    </>
  );
}

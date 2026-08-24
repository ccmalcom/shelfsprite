/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import InviteHashRedirect from '@/components/InviteHashRedirect';

const forwardInviteHash = jest.fn();

jest.mock('@/lib/authRedirect', () => ({
  forwardInviteHash: (...a: unknown[]) => forwardInviteHash(...a),
}));

beforeEach(() => forwardInviteHash.mockClear());

/**
 * The forwarding rules themselves (invite, recovery, error, empty and unrelated hashes) are
 * covered against a stub location in lib/__tests__/authRedirect.test.ts. jsdom's window.location
 * is non-configurable and its replace() is read-only, so this file owns what is left: the
 * component hands the live location to the forwarder on mount, and renders nothing.
 */
describe('InviteHashRedirect', () => {
  it('forwards the live window.location on mount', () => {
    render(<InviteHashRedirect />);
    expect(forwardInviteHash).toHaveBeenCalledTimes(1);
    expect(forwardInviteHash).toHaveBeenCalledWith(window.location);
  });

  it('renders nothing', () => {
    const { container } = render(<InviteHashRedirect />);
    expect(container).toBeEmptyDOMElement();
  });
});

/**
 * Unit tests for RoleBadges (#873): the Access cell of the console's
 * coordinator list.
 *
 * Covers: one badge per role labelled by name, the key when no name is known,
 * and a dash for a coordinator with no additional role.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RoleBadges } from '@/components/console/RoleBadges';

const NAMES = { data_export: 'Data Export', pii_access: 'PII Access' };

describe('<RoleBadges />', () => {
  it('shows one badge per role, labelled by the role name', () => {
    render(<RoleBadges roles={['data_export', 'pii_access']} names={NAMES} />);
    expect(screen.getByText('Data Export')).toBeInTheDocument();
    expect(screen.getByText('PII Access')).toBeInTheDocument();
  });

  it('falls back to the role key when the name is unknown', () => {
    render(<RoleBadges roles={['custom_role']} names={NAMES} />);
    expect(screen.getByText('custom_role')).toBeInTheDocument();
  });

  it('shows a dash when the coordinator holds no additional role', () => {
    const { container } = render(<RoleBadges roles={[]} names={NAMES} />);
    expect(container.textContent).toBe('—');
  });
});

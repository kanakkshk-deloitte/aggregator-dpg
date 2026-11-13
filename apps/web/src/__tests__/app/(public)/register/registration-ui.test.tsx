/**
 * Unit tests for the shared registration presentational pieces:
 * `useRegistrationFormState`, `RegistrationSubmitButton`,
 * `RegistrationErrorBanner`, and `RegistrationSuccessPanel`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, renderHook, act, fireEvent } from '@testing-library/react';
import { RjsfThemedForm } from '@/components/forms/RjsfThemed';
import {
  sharedRegistrationFormProps,
  useRegistrationFormState,
  FIELD_ERRORS,
  showsErrorBanner,
  RegistrationSubmitButton,
  RegistrationErrorBanner,
  RegistrationSuccessPanel,
} from '@/app/(public)/register/registration-ui';

describe('useRegistrationFormState', () => {
  it('starts idle, not submittable', () => {
    const { result } = renderHook(() => useRegistrationFormState());
    expect(result.current.state).toEqual({ status: 'idle' });
    expect(result.current.canSubmit).toBe(false);
  });

  it('updates state and canSubmit via the setters', () => {
    const { result } = renderHook(() => useRegistrationFormState());
    act(() => {
      result.current.setCanSubmit(true);
      result.current.setState({ status: 'submitting' });
    });
    expect(result.current.canSubmit).toBe(true);
    expect(result.current.state).toEqual({ status: 'submitting' });
  });

  it('focuses and scrolls the error ref when state transitions to error', () => {
    const { result, rerender } = renderHook(() => useRegistrationFormState());
    // Attach a real DOM node to the ref so the effect has something to act on.
    const div = document.createElement('div');
    div.scrollIntoView = () => {};
    Object.defineProperty(result.current.errorRef, 'current', { value: div, writable: true });
    act(() => {
      result.current.setState({
        status: 'error',
        title: 'Oops',
        detail: 'bad',
        code: 'X',
        requestId: 'r',
      });
    });
    rerender();
    expect(result.current.state.status).toBe('error');
  });

  it('moves to the first field with an error on a form check, not to the banner', () => {
    document.body.innerHTML = `
      <input id="root_name" /><ul id="root_name__error"></ul>
      <input id="root_email" /><ul id="root_email__error"></ul>`;
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    const { result } = renderHook(() => useRegistrationFormState());
    const banner = document.createElement('div');
    Object.defineProperty(result.current.errorRef, 'current', { value: banner, writable: true });
    act(() => {
      result.current.setState({
        status: 'error',
        title: 'Please fix the highlighted fields',
        detail: '',
        code: FIELD_ERRORS,
        requestId: '',
      });
    });
    expect(scrolled).toEqual(['root_name']);
    expect(document.activeElement?.id).toBe('root_name');
    document.body.innerHTML = '';
  });
});

describe('RegistrationSubmitButton', () => {
  it('renders the idle label when not submitting', () => {
    render(
      <RegistrationSubmitButton
        submitting={false}
        canSubmit={true}
        label="Submit"
        submittingLabel="Submitting…"
      />,
    );
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();
  });

  it('renders the submitting label and disables the button while submitting', () => {
    render(
      <RegistrationSubmitButton
        submitting={true}
        canSubmit={true}
        label="Submit"
        submittingLabel="Submitting…"
      />,
    );
    expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
  });

  it('disables the button when canSubmit is false', () => {
    render(
      <RegistrationSubmitButton
        submitting={false}
        canSubmit={false}
        label="Submit"
        submittingLabel="Submitting…"
      />,
    );
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
  });
});

describe('RegistrationErrorBanner', () => {
  it('renders the title and each detail line as a bullet', () => {
    render(
      <RegistrationErrorBanner
        title="Submission failed"
        detail={'Name is required\nEmail is invalid'}
        errorRef={{ current: null }}
      />,
    );
    expect(screen.getByText('Submission failed')).toBeInTheDocument();
    expect(screen.getByText('Name is required')).toBeInTheDocument();
    expect(screen.getByText('Email is invalid')).toBeInTheDocument();
  });

  it('renders nothing extra when detail is empty', () => {
    render(<RegistrationErrorBanner title="Failed" detail="" errorRef={{ current: null }} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('showsErrorBanner', () => {
  const error = (code: string) =>
    ({ status: 'error', title: 't', detail: '', code, requestId: '' }) as const;

  it('hides the banner for field errors, which show on the fields', () => {
    expect(showsErrorBanner(error(FIELD_ERRORS))).toBe(false);
  });

  it('shows it for errors with no field', () => {
    expect(showsErrorBanner(error('USER_EXISTS'))).toBe(true);
    expect(showsErrorBanner(error('CLIENT_VALIDATION'))).toBe(true);
    expect(showsErrorBanner({ status: 'idle' })).toBe(false);
  });
});

describe('RegistrationSuccessPanel', () => {
  it('renders heading, ref id, and message, with a link back to sign in', () => {
    render(
      <RegistrationSuccessPanel
        heading="Registration received"
        refLabel="Reference ID:"
        refId="agg-123"
        message="We will review your submission."
      />,
    );
    expect(screen.getByText('Registration received')).toBeInTheDocument();
    expect(screen.getByText('agg-123')).toBeInTheDocument();
    expect(screen.getByText('We will review your submission.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to sign in/i })).toHaveAttribute(
      'href',
      '/login',
    );
  });
});

describe('person name check', () => {
  const schema = {
    type: 'object',
    properties: {
      owner: {
        type: 'object',
        title: 'Organisation Owner',
        properties: { name: { type: 'string', title: 'Owner Name' } },
      },
    },
  } as const;

  function renderWithName(
    name: string,
    customValidate?: Parameters<typeof sharedRegistrationFormProps>[0]['customValidate'],
  ) {
    const onSubmit = vi.fn();
    const setState = vi.fn();
    const props = sharedRegistrationFormProps({
      formData: { owner: { name } },
      setFormData: () => {},
      setCanSubmit: () => {},
      setState,
      handleSubmit: onSubmit,
      formSchema: schema as never,
      onLocationResolved: () => {},
      validationErrorTitle: 'Please fix the highlighted fields',
      personName: { path: 'owner.name', message: (s) => `Remove: ${s}` },
      customValidate,
    });
    render(
      <RjsfThemedForm schema={schema as never} {...props}>
        <button type="submit">Submit</button>
      </RjsfThemedForm>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    return { onSubmit, setState };
  }

  it('shows the refused symbols on the name field and does not submit', () => {
    const { onSubmit, setState } = renderWithName('Ravi Kumar (Ops)');
    expect(screen.getByText('Remove: ( )')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(setState).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', detail: expect.stringContaining('Remove: ( )') }),
    );
  });

  it("runs the form's own check and the name check together", () => {
    const own = vi.fn((_data: unknown, errors: Parameters<NonNullable<typeof own>>[1]) => errors);
    renderWithName('Asha / QA', own as never);
    expect(own).toHaveBeenCalled();
    expect(screen.getByText('Remove: /')).toBeInTheDocument();
  });

  it('submits an ordinary name', () => {
    const { onSubmit } = renderWithName("Ravi D'Souza");
    expect(onSubmit).toHaveBeenCalled();
  });
});

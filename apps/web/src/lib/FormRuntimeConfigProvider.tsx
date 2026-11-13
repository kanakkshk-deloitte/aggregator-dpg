'use client';

/**
 * Passes the runtime-resolved {@link FormRuntimeConfig} from the server to the
 * schema-driven form widgets.
 *
 * The root layout resolves the config once per request and publishes it here,
 * so the values stay runtime settings rather than build-time `NEXT_PUBLIC_*`.
 * Consumers outside a provider get defaults: plain text inputs and the key-less
 * geocoder.
 *
 * @module apps/web/lib/FormRuntimeConfigProvider
 */

import { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_COLLEGE_DATASET, type FormRuntimeConfig } from './form-runtime-config';

const FormRuntimeConfigContext = createContext<FormRuntimeConfig | null>(null);

/** Used when no provider is above the consumer: no key, no overrides. */
const FALLBACK_CONFIG: FormRuntimeConfig = { collegeDataset: DEFAULT_COLLEGE_DATASET };

/**
 * Publishes the resolved form runtime config to client components.
 *
 * @param value - The resolved config, from `getFormRuntimeConfig()` on the server.
 * @param children - Subtree that may call `useFormRuntimeConfig`.
 */
export function FormRuntimeConfigProvider({
  value,
  children,
}: Readonly<{ value: FormRuntimeConfig; children: ReactNode }>) {
  return (
    <FormRuntimeConfigContext.Provider value={value}>{children}</FormRuntimeConfigContext.Provider>
  );
}

/**
 * Reads the form runtime config published by the root layout.
 *
 * @returns The resolved config, or the no-key defaults outside a provider.
 */
export function useFormRuntimeConfig(): FormRuntimeConfig {
  return useContext(FormRuntimeConfigContext) ?? FALLBACK_CONFIG;
}

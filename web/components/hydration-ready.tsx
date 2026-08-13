'use client';

import { useEffect } from 'react';

export function HydrationReady() {
  useEffect(() => {
    document.body.removeAttribute('inert');
    document.body.removeAttribute('aria-busy');
  }, []);

  return null;
}

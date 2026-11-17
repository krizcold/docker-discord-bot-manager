// For files that test an order path the save order does not change (NX5 decision 4: an app without
// companionDb.saveOrder keeps today's plans): the real manifest less its saveOrder, so no order, wait or final read runs.
export function withoutSaveOrder<C extends { companionDb?: object } | null | undefined>(caps: C): C {
  if (!caps?.companionDb || !('saveOrder' in caps.companionDb)) return caps;
  const { saveOrder: _dropped, ...companionDb } = caps.companionDb as { saveOrder?: boolean };
  return { ...caps, companionDb } as C;
}

export async function capsWithoutSaveOrder(real: typeof import('../../src/config/appCapabilities')): Promise<Record<string, unknown>> {
  return { ...real, findAppCapabilities: (url: string | null | undefined) => withoutSaveOrder(real.findAppCapabilities(url as string)) };
}

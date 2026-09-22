import type { ProviderInfo, Requests, Settings } from "../shared/contracts";

// Seed an existing installation without changing its visibility choices. Only
// connected providers establish a baseline; reconnecting never resets it.
export function discoverModels(
  settings: Settings,
  providers: ProviderInfo[],
): Partial<Settings> | undefined {
  const catalogs = { ...settings.modelCatalogs };
  const hidden = new Set(settings.hiddenModels ?? []);
  let changed = false;
  for (const provider of providers) {
    if (!provider.configured) continue;
    const previous = catalogs[provider.id];
    const known = new Set(previous?.known);
    const added = provider.models
      .map((model) => model.id)
      .filter((id) => !known.has(id));
    if (previous && !added.length) continue;
    // An empty initial response is not a successful first catalog.
    if (!previous && !provider.models.length) continue;
    changed = true;
    for (const id of added) {
      known.add(id);
      if (previous) hidden.add(`${provider.id}/${id}`);
    }
    catalogs[provider.id] = {
      known: [...known],
      new: previous ? [...new Set([...previous.new, ...added])] : [],
    };
  }
  return changed
    ? { modelCatalogs: catalogs, hiddenModels: [...hidden] }
    : undefined;
}

export function selectModels(
  settings: Settings,
  input: Requests["modelSelection"]["input"],
): Partial<Settings> {
  const catalog = settings.modelCatalogs?.[input.provider];
  const known = new Set(catalog?.known);
  const reviewed = new Set(input.reviewed);
  if (
    !catalog ||
    input.reviewed.some((id) => !known.has(id)) ||
    input.selected.some((id) => !reviewed.has(id))
  ) {
    throw new Error("Unknown model selection");
  }
  const selected = new Set(input.selected);
  const hidden = new Set(settings.hiddenModels ?? []);
  for (const id of reviewed) {
    const key = `${input.provider}/${id}`;
    selected.has(id) ? hidden.delete(key) : hidden.add(key);
  }
  return {
    hiddenModels: [...hidden],
    modelCatalogs: {
      ...settings.modelCatalogs,
      [input.provider]: {
        ...catalog,
        new: catalog.new.filter((id) => !reviewed.has(id)),
      },
    },
  };
}

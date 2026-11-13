// Keep the same id after an ambiguous transport failure. A retry must not
// become a second App Server turn. Clear it only after a definite response.
export function mergeCommandReceipt(receipts, incoming) {
  const rank = { received: 0, accepted: 1, executing: 2, uncertain: 3, succeeded: 4, failed: 4, interrupted: 4 };
  if (!incoming || !Object.hasOwn(rank, incoming.stage)) return receipts;
  const previous = receipts.find(r => r.commandId === incoming.commandId);
  if (previous && (rank[previous.stage] === 4 || rank[incoming.stage] < rank[previous.stage] && !(previous.stage === "uncertain" && incoming.stage === "executing"))) return receipts;
  return [incoming, ...receipts.filter(r => r.commandId !== incoming.commandId)].slice(0, 20);
}

export function createCommandDispatcher(send, uuid = () => crypto.randomUUID()) {
  const pending = new Map();
  return (command) => {
    const key = JSON.stringify(command);
    let entry = pending.get(key);
    if (entry?.flight) return entry.flight;
    entry ||= { id: uuid() };
    pending.set(key, entry);
    entry.flight = Promise.resolve().then(() => send({ id: entry.id, ...command }))
      .then(result => { pending.delete(key); return { ...result, id: entry.id }; })
      .catch(error => { if (error.status >= 400 && error.status < 500) pending.delete(key); throw error; })
      .finally(() => { entry.flight = null; });
    return entry.flight;
  };
}

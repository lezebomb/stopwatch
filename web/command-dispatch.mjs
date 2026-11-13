// Keep the same id after an ambiguous transport failure. A retry must not
// become a second App Server turn. Clear it only after a definite response.
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

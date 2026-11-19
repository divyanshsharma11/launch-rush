// Runs every close function even if one fails, then rejects with the first failure.
export async function closeAll(closers) {
  const results = await Promise.allSettled(closers.map((close) => close()));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}

// Live reads intentionally span completed publication batches. Each entity JSON
// remains atomic, while the view grows without waiting for the final commit.
export async function progressiveMembers(client, base, cohort) {
  const current = `${base}:snapshot:${cohort}`;
  const oldText = await client.sendCommand(['JSON.GET', current]);
  const token = await client.get(`${base}:publishing`);
  const work = token ? `${base}:staging:${token}:commit` : null;
  const progress = work ? await client.hGetAll(work) : {};
  const incoming = progress.cohort === cohort && progress.metadata ? JSON.parse(progress.metadata) : null;
  const previous = oldText ? JSON.parse(oldText) : null;
  if (!previous && !incoming) throw new Error('Redis projection not ready');
  const split = async (metadata, key) => {
    if (!metadata) return [];
    const rows = [];
    let offset = 0;
    for (const group of metadata.groups) {
      const keys = [];
      for (let i = 0; i < group.count; i += 500) {
        const page = await client.lRange(key, offset + i, offset + Math.min(i + 499, group.count - 1));
        keys.push(...page);
        if (page.length < Math.min(500, group.count - i)) break;
      }
      rows.push({path:group.path, keys}); offset += group.count;
    }
    return rows;
  };
  const [oldGroups, newGroups] = await Promise.all([
    split(previous, `${current}:members`), split(incoming, `${work}:members`),
  ]);
  const metadata = incoming || previous;
  const groups = metadata.groups.map(group => {
    const same = row => JSON.stringify(row.path) === JSON.stringify(group.path);
    const fresh = newGroups.find(same)?.keys || [];
    const old = oldGroups.find(same)?.keys || [];
    return {path:group.path, keys:[...new Set([...fresh, ...old])]};
  });
  // Finish may have swapped the member list while we were reading the temporary
  // one. Retry the committed snapshot instead of returning a spurious empty view.
  if (incoming && !await client.exists(work)) return progressiveMembers(client, base, cohort);
  if (metadata.count && !groups.some(group => group.keys.length)) throw new Error('Redis projection not ready');
  return {metadata, groups};
}

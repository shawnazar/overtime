// GitHub Actions workflow commands when inside Actions, plain lines otherwise.
const inActions = () => process.env.GITHUB_ACTIONS === "true";
const esc = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export const log = {
  info: (m: string) => console.log(m),
  notice: (m: string) => console.log(inActions() ? `::notice::${esc(m)}` : `NOTICE ${m}`),
  warn: (m: string) => console.log(inActions() ? `::warning::${esc(m)}` : `WARN ${m}`),
  error: (m: string) => console.log(inActions() ? `::error::${esc(m)}` : `ERROR ${m}`),
  mask: (secret: string) => { if (inActions() && secret) console.log(`::add-mask::${secret}`); },
  group: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    if (inActions()) console.log(`::group::${esc(name)}`);
    try { return await fn(); } finally { if (inActions()) console.log("::endgroup::"); }
  },
};

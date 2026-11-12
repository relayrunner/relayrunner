import { useEffect } from "react";

const APP = "RelayRunner";

/** Names the browser tab after the page, such as "Runners · RelayRunner". */
export function usePageTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · ${APP}` : APP;
    return () => {
      document.title = APP;
    };
  }, [title]);
}

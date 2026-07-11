import { useEffect } from "react";

interface PageHeadProps {
  title: string;
  description?: string;
  /** SlabVault is a private admin tool — pages default to noindex. */
  noindex?: boolean;
}

/**
 * Minimal document-head manager. Sets the page title and (by default) a
 * noindex robots meta, since this is a private inventory app.
 */
export function PageHead({ title, description, noindex = true }: PageHeadProps) {
  useEffect(() => {
    if (title) document.title = title;

    if (description) {
      let tag = document.querySelector('meta[name="description"]');
      if (!tag) {
        tag = document.createElement("meta");
        tag.setAttribute("name", "description");
        document.head.appendChild(tag);
      }
      tag.setAttribute("content", description);
    }

    let robots = document.querySelector('meta[name="robots"]');
    if (!robots) {
      robots = document.createElement("meta");
      robots.setAttribute("name", "robots");
      document.head.appendChild(robots);
    }
    robots.setAttribute("content", noindex ? "noindex, nofollow" : "index, follow");
  }, [title, description, noindex]);

  return null;
}

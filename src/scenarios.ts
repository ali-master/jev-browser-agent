export function scenarios(now = new Date()) {
  const date = (days: number) => {
    const value = new Date(now);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  };
  const depart = date(45),
    back = date(52);
  const flights = "https://www.google.com/travel/flights?hl=en";
  const consent = "Reject optional cookies if prompted. ";
  const searchOnly = " Stop at the flight results; do not book or sign in.";
  return [
    {
      id: "travel",
      group: "Local demos",
      label: "Travel planner",
      description: "Search, filter, and open a stay.",
      url: "/fixture.html?scenario=travel",
      goal: "Find a Design stay in Lisbon with Free cancellation and open Casa Flora.",
    },
    {
      id: "crowded",
      group: "Local demos",
      label: "Travel planner · crowded",
      description: "Six steps with filters, distractions, and scrolling.",
      url: "/fixture.html?scenario=travel&crowded=1",
      goal: "Type Lisbon in Destination; select Design in Stay category; enable Free cancellation; submit with Find stays; scroll to Casa Flora and click View Casa Flora to open its details page.",
    },
    {
      id: "research",
      group: "Local demos",
      label: "Reading room",
      description: "Find and open the browser-agent article.",
      url: "/fixture.html?scenario=research",
      goal: "Open the article about using finite choices to control browser agents.",
    },
    {
      id: "flights",
      group: "Google Flights",
      label: "Flights · open search",
      description: "Handle consent and reach the real search form.",
      url: flights,
      goal: "Reject optional cookies if prompted, then open the Google Flights flight search page.",
    },
    {
      id: "flights-one-way",
      group: "Google Flights",
      label: "Flights · one-way route",
      description: `LHR → LIS · ${depart} · one adult.`,
      url: flights,
      goal: `${consent}Find one-way economy flights for one adult from London Heathrow (LHR) to Lisbon (LIS) departing ${depart}. Select the matching airports from suggestions, set the departure date, and run the search. Verify the route, date, and one-way trip type on the results page.${searchOnly}`,
    },
    {
      id: "flights-round-trip",
      group: "Google Flights",
      label: "Flights · round trip for two",
      description: `AMS ↔ FCO · ${depart} to ${back} · two adults.`,
      url: flights,
      goal: `${consent}Find round-trip economy flights for two adults from Amsterdam Schiphol (AMS) to Rome Fiumicino (FCO), departing ${depart} and returning ${back}. Select the matching airports, set both dates and two adults, and search. Verify the route, both dates, and passenger count on the results page.${searchOnly}`,
    },
    {
      id: "flights-nonstop",
      group: "Google Flights",
      label: "Flights · nonstop comparison",
      description: `JFK → LAX · ${depart} · compare visible options.`,
      url: flights,
      goal: `${consent}Search one-way economy flights for one adult from New York John F. Kennedy (JFK) to Los Angeles (LAX) on ${depart}. Set the Stops filter to nonstop. Compare two visible nonstop results: report the airline, departure time, duration, and displayed price with currency. If fewer than two results exist, report that accurately. Verify the route, date, and nonstop filter.${searchOnly}`,
    },
    {
      id: "books-compare",
      group: "Practice websites",
      label: "Books to Scrape · compare products",
      description:
        "Practice shop · category, product details, and price comparison.",
      url: "https://books.toscrape.com/",
      goal: "Open the Mystery category on Books to Scrape. Open the first two books individually, returning to the category through the breadcrumb between them. Report each full title, displayed price with currency, and stock availability from its product page. Compare the prices and cite both product URLs. Stop after the comparison; do not add anything to the basket. This is a practice shop with fictional prices.",
    },
    {
      id: "books-pagination",
      group: "Practice websites",
      label: "Books to Scrape · catalog pagination",
      description:
        "Practice shop · browse a category, turn the page, inspect a product.",
      url: "https://books.toscrape.com/",
      goal: "Open the Fiction category on Books to Scrape, scroll to its pagination, and go to the second page. Open the first book on that second page. Report its full title, UPC, displayed price with currency, and stock availability from the product information. Cite the product URL and stop on its details page without adding it to the basket.",
    },
    {
      id: "quotes-tags",
      group: "Practice websites",
      label: "Quotes to Scrape · tags and authors",
      description:
        "Practice site · filter by a tag and follow an author biography.",
      url: "https://quotes.toscrape.com/",
      goal: "On Quotes to Scrape, open the books tag. Find a quote by Jane Austen in the filtered list and open the about link belonging to her quote. Report her displayed birth date and birthplace, and cite the biography URL. Stop on her biography page; do not log in.",
    },
    {
      id: "quotes-pagination",
      group: "Practice websites",
      label: "Quotes to Scrape · paginated discovery",
      description:
        "Practice site · next page, first author, and biography details.",
      url: "https://quotes.toscrape.com/",
      goal: "On Quotes to Scrape, use Next to reach the second page of quotes. Identify the author of the first quote on that page and open that quote's about link. Report the author's name, displayed birth date, and birthplace, citing the biography URL. Stop on that author's biography page; do not log in.",
    },
    {
      id: "wikipedia",
      group: "Research on real websites",
      label: "Wikipedia · linked research",
      description: "Search, follow a related article, and cite both pages.",
      url: "https://en.wikipedia.org/wiki/Main_Page",
      goal: "Search Wikipedia for Gödel's incompleteness theorems and open the article. Read the first incompleteness theorem section. Follow a link to the formal system article. Explain in two sentences how formal systems relate to the first theorem and cite both page URLs. Stop after reading; do not edit anything.",
    },
    {
      id: "hacker-news",
      group: "Research on real websites",
      label: "Hacker News · compare discussions",
      description: "Visit two discussions and compare visible evidence.",
      url: "https://news.ycombinator.com/",
      goal: "From Hacker News, open the comments page for each of the first two stories that have comments. Record each story's title, points, comment count, and one visible discussion topic. Return to the front page between stories using the site navigation. Summarize the differences and cite both discussion URLs. Do not vote, sign in, or post.",
    },
    {
      id: "github",
      group: "Research on real websites",
      label: "GitHub · release research",
      description: "Inspect a public repository and its latest release.",
      url: "https://github.com/oven-sh/bun",
      goal: "On the public oven-sh/bun GitHub repository, open Releases and open the latest stable release (not a prerelease). Report the version, publication date, and two fixes from its release notes, then open the source tag page and cite both URLs. Do not sign in, download assets, or change anything.",
    },
    {
      id: "open-library",
      group: "Research on real websites",
      label: "Open Library · advanced book search",
      description:
        "Fill title and author fields, search, and inspect an edition.",
      url: "https://openlibrary.org/advancedsearch",
      goal: "Use Open Library's advanced search to find The Time Machine by H. G. Wells, entering the title and author in their respective fields. Submit the search, open the matching work, and open one of its listed editions. Report the edition's title, author, publisher, publication year, and language as displayed; identify any missing information instead of guessing. Cite the edition URL and stop there. Do not sign in, borrow, or edit the catalog.",
    },
    {
      id: "gutenberg",
      group: "Research on real websites",
      label: "Gutenberg · find and read a classic",
      description:
        "Search for a book, inspect its formats, and open the online text.",
      url: "https://www.gutenberg.org/",
      goal: "Search Project Gutenberg for Pride and Prejudice by Jane Austen and open the matching English book page. Report its author, language, and two available reading formats. Open Read online, navigate to Chapter I, and confirm its heading is visible. Cite the catalog and online reading URLs. Stop at Chapter I without downloading files.",
    },
    {
      id: "mdn",
      group: "Research on real websites",
      label: "MDN · compare array methods",
      description:
        "Follow reference links, read examples, and compare two APIs.",
      url: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array",
      goal: "From MDN's Array reference, open Array.prototype.map() and read its return value and examples. Then use the reference navigation to open Array.prototype.filter() and read the same sections. Explain how the methods differ and whether each changes the original array, based on these pages. Cite both reference URLs and stop after the comparison. Do not sign in or edit anything.",
    },
    {
      id: "nasa",
      group: "Research on real websites",
      label: "NASA · compare planet facts",
      description:
        "Browse planet pages, find facts, and compare orbital periods.",
      url: "https://science.nasa.gov/solar-system/planets/",
      goal: "From NASA's planet directory, open the Mars facts page and read its Orbit and Rotation section. Then use the site navigation to open the Venus facts page and read the same section. Report each planet's rotation period and orbital period with units, then compare which takes longer to rotate and which takes longer to orbit the Sun. Cite both facts page URLs and stop after the comparison.",
    },
    {
      id: "custom",
      group: "Your task",
      label: "Your website",
      description: "Choose a starting URL and write your own goal.",
      url: "",
      goal: "",
    },
  ];
}

export function scenarioOptions(now = new Date()) {
  let group = "";
  return (
    scenarios(now)
      .map((scenario) => {
        const heading =
          scenario.group !== group
            ? `${group ? "</optgroup>" : ""}<optgroup label="${Bun.escapeHTML(scenario.group)}">`
            : "";
        group = scenario.group;
        return `${heading}<option value="${scenario.id}" data-description="${Bun.escapeHTML(scenario.description)}" data-goal="${Bun.escapeHTML(scenario.goal)}">${Bun.escapeHTML(scenario.label)}</option>`;
      })
      .join("") + "</optgroup>"
  );
}

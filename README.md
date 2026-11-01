# LMIA Watch

Public records of Labour Market Impact Assessment (LMIA) activity in Canada: which
employers are applying to hire temporary foreign workers, where, when, and which
applications were approved or refused. Every row links to the government record it
came from. The site rebuilds itself once a day, at midnight UTC, from the
sources (retried at 06:00 and 12:00 UTC when that run did not finish clean);
the scheduled run is the only way its data changes.

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23488706.svg)](https://doi.org/10.5281/zenodo.23488706)

## Layout
```
pipeline/   Python: scrape, load, merge, indicators, export (owns data/lmia.sqlite)
site/       Cloudflare Worker: pages + JSON API over the pipeline's static JSON
pipeline/schema.sql   the one schema both halves use
data/       raw downloads and outputs (git-ignored)
site/design/wireframes/   the page structure the site implements
.github/workflows/nightly.yml   the one scheduled run that refreshes data and deploys
.github/workflows/deploy-site.yml   a manual site-only deploy that cannot touch the data (docs/site-deploy.md)
```

The data ships as static assets with the Worker, the browser filters the
map page, a database of its own answers the search page over every record
since 2014 (the static files are its fallback), another holds only what
visitors submit, and object storage holds the downloads.

## Quick start
```
cd pipeline && pip install -e .[dev] && pytest
python -m lmia_pipeline run --limit 1 --detail-budget 2 --db ../data/lmia.sqlite

cd ../site && npm install && npm run db:local && npm run data:local && npm run dev
```

The operating rules (operator anonymity, crawl politeness, what is stored and
what is published) are kept outside the repository.

## Sources and licences
The ESDC positive and negative LMIA employer lists are published on open.canada.ca
under the Open Government Licence, Canada. Job Bank content is Government of Canada
material reproduced with attribution. The IRCC list of employers found non-compliant
is published on canada.ca. The program conditions page reads three ESDC pages on
canada.ca (LMIA processing times, the low-wage refusal-to-process list, the wage
thresholds), reproduced under the canada.ca terms and conditions
(`docs/program-conditions.md`). Each derived file keeps the terms of its sources.
Files derived only from ESDC's lists and the federal corporations extract are under
the Open Government Licence, Canada. Job Bank and IRCC material stays under the
Government of Canada terms of use on canada.ca. Quebec register fields are under
CC BY-NC-SA 4.0. Profiles also show federal grants and contributions (Open
Government Licence, Canada), Alberta Employer Records (Open Government Licence,
Alberta) and US FMCSA carrier census records (public domain), each matched to
employers by name and place (see `docs/grants.md`, `docs/alberta-employer-records.md`
and `docs/fmcsa.md`). The licence table on the site's Data page is the reference.

## Citing the data
The files derived from ESDC's lists (the approved and refused quarterly lists
and the index of source files with their checksums) are deposited on Zenodo,
one version per ESDC quarter.

| | DOI |
|---|---|
| All versions (resolves to the newest) | [10.5281/zenodo.23488706](https://doi.org/10.5281/zenodo.23488706) |
| 2026 Q1 | [10.5281/zenodo.23488707](https://doi.org/10.5281/zenodo.23488707) |
| 2026 Q2 | [10.5281/zenodo.23826575](https://doi.org/10.5281/zenodo.23826575) |

To cite a figure, use the version you worked from:

> LMIA Watch (2026). *LMIA Watch: ESDC positive and negative LMIA employer
> lists, derived files* (Version 2026Q2) [Data set]. Zenodo.
> https://doi.org/10.5281/zenodo.23826575

Later versions are listed on the record page, and the site's Data page shows
the citation for the newest one.

## Code licence
The code, documentation, page text, design and brand in this repository are
source-available under [LICENSE.md](LICENSE.md): published for inspection, not
licensed for copying, redistribution or running another site. The data licences
above are unaffected. The project does not accept issues, pull requests or
contributions; reports about records go through the site's corrections form.

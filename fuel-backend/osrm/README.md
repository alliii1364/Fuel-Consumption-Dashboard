# OSRM routing engine (dispatch feature)

The dispatch feature uses a **self-hosted OSRM** instance for route
optimization, road-network geometry, and ETAs. The backend talks to it via the
`OSRM_URL` env var (default `http://localhost:5000`).

## One-time setup

1. **Download an OSM extract** for your region into `./data` (Pakistan example):
   ```bash
   mkdir -p data && cd data
   curl -O https://download.geofabrik.de/asia/pakistan-latest.osm.pbf
   cd ..
   ```
   Browse https://download.geofabrik.de for other regions/countries.

2. **Pre-process** the extract (MLD pipeline — matches the `--algorithm mld`
   used in `docker-compose.yml`):
   ```bash
   export REGION=pakistan
   docker run -t -v "$PWD/data:/data" ghcr.io/project-osrm/osrm-backend \
     osrm-extract -p /opt/car.lua /data/$REGION-latest.osm.pbf
   docker run -t -v "$PWD/data:/data" ghcr.io/project-osrm/osrm-backend \
     osrm-partition /data/$REGION-latest.osrm
   docker run -t -v "$PWD/data:/data" ghcr.io/project-osrm/osrm-backend \
     osrm-customize /data/$REGION-latest.osrm
   ```

3. **Run** it:
   ```bash
   REGION=pakistan docker compose up -d
   ```

## Verify

```bash
# Two Karachi coords (lng,lat); expect {"code":"Ok",...}
curl "http://localhost:5000/route/v1/driving/67.0011,24.8607;67.0700,24.9000?overview=false"
```

Until OSRM is running, route **creation/optimization** endpoints return
`503 Service Unavailable` ("Routing engine unreachable"). Everything else
(drivers, assignments, manual single-stop routes) works without it.

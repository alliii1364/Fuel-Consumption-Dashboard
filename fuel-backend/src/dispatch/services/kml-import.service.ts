import { BadRequestException, Injectable } from '@nestjs/common';
import { LatLng } from './geo.util';

export interface ParsedKml {
  /** Point placemarks → candidate stops. */
  stops: Array<{ name: string; lat: number; lng: number }>;
  /** Concatenated LineString / Track geometry, if any. */
  path: LatLng[];
}

/**
 * Minimal, dependency-free KML parser. Extracts <Placemark> points as stops
 * and LineString/gx:Track geometry as a path. KML <coordinates> are
 * whitespace-separated "lng,lat[,alt]" tuples.
 */
@Injectable()
export class KmlImportService {
  parse(kml: string): ParsedKml {
    if (!kml || !/<kml[\s>]/i.test(kml)) {
      throw new BadRequestException('File does not look like valid KML');
    }

    const stops: ParsedKml['stops'] = [];
    const path: LatLng[] = [];

    const placemarks = [
      ...kml.matchAll(/<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi),
    ];

    let stopCounter = 0;
    for (const m of placemarks) {
      const block = m[1];
      const name = (
        block.match(/<name>([\s\S]*?)<\/name>/i)?.[1] || ''
      )
        .replace(/<!\[CDATA\[|\]\]>/g, '')
        .trim();
      const isLine = /<LineString|<gx:Track|<LinearRing/i.test(block);

      const coordsRaw = block.match(/<coordinates>([\s\S]*?)<\/coordinates>/i)?.[1];
      const pts = coordsRaw ? this.parseCoords(coordsRaw) : [];
      if (pts.length === 0) continue;

      if (isLine) {
        path.push(...pts);
      } else {
        stopCounter += 1;
        stops.push({
          name: name || `Stop ${stopCounter}`,
          lat: pts[0].lat,
          lng: pts[0].lng,
        });
      }
    }

    if (stops.length === 0 && path.length === 0) {
      throw new BadRequestException(
        'No usable placemarks or paths found in the KML file',
      );
    }
    return { stops, path };
  }

  private parseCoords(raw: string): LatLng[] {
    return raw
      .trim()
      .split(/\s+/)
      .map((tuple) => {
        const [lng, lat] = tuple.split(',').map((n) => parseFloat(n));
        return Number.isFinite(lat) && Number.isFinite(lng)
          ? ({ lat, lng } as LatLng)
          : null;
      })
      .filter((p): p is LatLng => p !== null);
  }
}

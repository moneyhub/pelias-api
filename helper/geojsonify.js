const GeoJSON = require('geojson');
const extent = require('@mapbox/geojson-extent');
const logger = require('pelias-logger').get('geojsonify');
const collectDetails = require('./geojsonify_place_details');
const _ = require('lodash');
const Document = require('@mft/pelias-model').Document;
const codec = require('@mft/pelias-model').codec;
const field = require('./fieldValue');
const decode_gid = require('./decode_gid');
const iso3166 = require('./iso3166');

function geojsonifyPlaces( params, docs ){

  // flatten & expand data for geojson conversion
  const geodata = docs
    .filter(doc => {
      if (!_.has(doc, 'center_point')) {
        logger.warn('No doc or center_point property');
        return false;
      } else {
        return true;
      }
    })
    .map(geojsonifyPlace.bind(null, params));

  // get all the bounding_box corners as well as single points
  // to be used for computing the overall bounding_box for the FeatureCollection
  const extentPoints = extractExtentPoints(geodata);

  // convert to geojson
  const geojson             = GeoJSON.parse( geodata, { Point: ['lat', 'lng'] });
  const geojsonExtentPoints = GeoJSON.parse( extentPoints, { Point: ['lat', 'lng'] });

  // to insert the bbox property at the top level of each feature, it must be done separately after
  // initial geojson construction is finished
  addBBoxPerFeature(geojson);

  // add properties with the ISO3166 (country code) info
  addISO3166PropsPerFeature(geojson);

  // bounding box calculations
  computeBBox(geojson, geojsonExtentPoints);

  return geojson;
}

function geojsonifyPlace(params, place) {
  const gid_components = decode_gid(place._id);
  // setup the base doc
  const doc = {
    id: gid_components.id,
    gid: new Document(place.source, place.layer, gid_components.id).getGid(),
    layer: place.layer,
    source: place.source,
    source_id: gid_components.id,
    country_code: undefined,
    bounding_box: place.bounding_box,
    lat: parseFloat(place.center_point.lat),
    lng: parseFloat(place.center_point.lon),
  };

  // assign name, logging a warning if it doesn't exist
  if (_.has(place, 'name.default')) {
    doc.name = field.getStringValue(place.name.default);
  } else {
    logger.warn(`doc ${doc.gid} does not contain name.default`);
  }

  // assign all the details info into the doc
  Object.assign(doc, collectDetails(params, place));

  // add addendum data if available
  // note: this should be the last assigned property, for aesthetic reasons.
  if (_.has(place, 'addendum')) {
    let addendum = {};
    for(let namespace in place.addendum){
      try {
        addendum[namespace] = codec.decode(place.addendum[namespace]);
      } catch( e ){
        logger.warn(`doc ${doc.gid} failed to decode addendum namespace ${namespace}`);
      }
    }
    if( Object.keys(addendum).length ){
      doc.addendum = addendum;
    }
  }

  if (place.debug) {
    doc.debug = place.debug;
  }

  return doc;
}

/**
 * Add bounding box
 *
 * @param {object} geojson
 */
function addBBoxPerFeature(geojson) {
  geojson.features.forEach(feature => {
    if (feature.properties.bounding_box) {
      feature.bbox = [
        feature.properties.bounding_box.min_lon,
        feature.properties.bounding_box.min_lat,
        feature.properties.bounding_box.max_lon,
        feature.properties.bounding_box.max_lat
      ];
    }

    delete feature.properties.bounding_box;
  });
}

/**
 * Collect all points from the geodata.
 * If an item is a single point, just use that.
 * If an item has a bounding box, add two corners of the box as individual points.
 *
 * @param {Array} geodata
 * @returns {Array}
 */
function extractExtentPoints(geodata) {
  return geodata.reduce((extentPoints, place) => {
    // if there's a bounding_box, use the LL/UR for the extent
    if (place.bounding_box) {
      extentPoints.push({
        lng: place.bounding_box.min_lon,
        lat: place.bounding_box.min_lat
      });
      extentPoints.push({
        lng: place.bounding_box.max_lon,
        lat: place.bounding_box.max_lat
      });

    }
    else {
      // otherwise, use the point for the extent
      extentPoints.push({
        lng: place.lng,
        lat: place.lat
      });

    }
    return extentPoints;

  }, []);

}

/**
 * Compute bbox that encompasses all features in the result set.
 * Set bbox property on the geojson object.
 *
 * @param {object} geojson
 */
function computeBBox(geojson, geojsonExtentPoints) {
  // @note: extent() sometimes throws Errors for unusual data
  // eg: https://github.com/pelias/pelias/issues/84
  try {
    var bbox = extent( geojsonExtentPoints );
    if( !!bbox ){
      geojson.bbox = bbox;
    }
  } catch( e ){
    logger.error( 'bbox error', e.message, e.stack );
    logger.error( 'geojson', geojsonExtentPoints );
  }
}

/**
 * Add ISO3166-1 (country code) properties
 *
 * @param {object} geojson
 */
function addISO3166PropsPerFeature(geojson) {
  geojson.features.forEach(feature => {
    let code = _.get(feature, 'properties.country_a') || _.get(feature, 'properties.dependency_a') || '';
    if (!_.isString(code) || _.isEmpty(code)){ return; }

    let info = iso3166.info(code);
    let alpha2 = _.get(info, 'alpha2');
    if (!_.isString(alpha2) || _.size(alpha2) !== 2) { return; }

    _.set(feature, 'properties.country_code', alpha2);
  });
}

module.exports = geojsonifyPlaces;

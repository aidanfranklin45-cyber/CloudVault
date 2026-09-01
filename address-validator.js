/**
 * CloudVault Address Validator & Regional Market Engine
 * Powered by Zippopotam.us (100% Free, Zero-Config Public Postal API)
 *
 * Features:
 * - Live 5-digit US ZIP Code lookup (City, State, Lat, Lng).
 * - Automatic City & State auto-population in address forms.
 * - City / State / ZIP mismatch detection and validation.
 * - Waitlist regional market categorization and clustering.
 */
(function (global) {
  'use strict';

  const AddressValidator = {
    cache: {},
    pendingRequests: {},

    /**
     * Look up postal information for any 5-digit US ZIP code
     * @param {string|number} zip - 5-digit US ZIP code
     * @returns {Promise<Object|null>} Resolved location data or null
     */
    async lookupZip(zip) {
      if (!zip) return null;
      const cleanZip = String(zip).trim().replace(/\D/g, '').slice(0, 5);
      if (cleanZip.length !== 5) return null;

      // 1. Check in-memory cache
      if (this.cache[cleanZip]) {
        return this.cache[cleanZip];
      }

      // 2. Deduplicate in-flight requests
      if (this.pendingRequests[cleanZip]) {
        return this.pendingRequests[cleanZip];
      }

      this.pendingRequests[cleanZip] = (async () => {
        try {
          const res = await fetch('https://api.zippopotam.us/us/' + cleanZip);
          if (!res.ok) {
            return null;
          }
          const data = await res.json();
          if (!data || !data.places || data.places.length === 0) {
            return null;
          }

          const primary = data.places[0];
          const allPlaces = data.places.map(p => (p['place name'] || '').toLowerCase());
          const stateCode = (primary['state abbreviation'] || '').toUpperCase();
          const stateFull = primary['state'] || '';
          const cityName = primary['place name'] || '';
          const lat = parseFloat(primary['latitude']) || null;
          const lng = parseFloat(primary['longitude']) || null;

          const regionalMarket = this.resolveRegionalMarket(cityName, stateCode, cleanZip, lat, lng);

          const result = {
            zip: cleanZip,
            city: cityName,
            state: stateCode,
            stateFullName: stateFull,
            latitude: lat,
            longitude: lng,
            allPlaces: allPlaces,
            places: data.places,
            regionalMarket: regionalMarket,
            formattedLabel: cityName + ', ' + stateCode + ' ' + cleanZip,
            marketLabel: regionalMarket + ' (' + cityName + ', ' + stateCode + ')'
          };

          this.cache[cleanZip] = result;
          return result;
        } catch (err) {
          console.warn('[AddressValidator] Lookup notice for ZIP ' + cleanZip + ':', err.message);
          return null;
        } finally {
          delete this.pendingRequests[cleanZip];
        }
      })();

      return this.pendingRequests[cleanZip];
    },

    /**
     * Classifies any US location into a strategic regional market cluster for waitlist and hub expansion
     */
    resolveRegionalMarket(city, state, zip, lat, lng) {
      const c = (city || '').toLowerCase().trim();
      const s = (state || '').toUpperCase().trim();
      const z = String(zip || '').trim();

      // --- 1. Washington State Clusters ---
      if (s === 'WA') {
        // Yakima Valley & Central WA (Yakima County, Kittitas County, Upper Yakima)
        const yakimaZips = ['98901', '98902', '98903', '98904', '98907', '98908', '98909', '98942', '98947', '98948', '98951', '98952', '98953', '98926', '98922', '98936', '98930'];
        if (yakimaZips.includes(z) || c.includes('yakima') || c === 'selah' || c === 'union gap' || c === 'ellensburg' || c === 'sunnyside' || c === 'toppenish' || c === 'wapato' || c === 'granger' || c === 'grandview' || c === 'zillah') {
          return 'Yakima Valley & Central WA';
        }

        // Greater Puget Sound / Seattle Metro (King, Pierce, Snohomish, Kitsap, Thurston)
        const pugetSoundCities = ['seattle', 'bellevue', 'tacoma', 'everett', 'renton', 'kent', 'auburn', 'federal way', 'redmond', 'kirkland', 'bothell', 'edmonds', 'lynnwood', 'olympia', 'lacey', 'puyallup', 'bremerton', 'silverdale', 'bainbridge island', 'mercer island', 'sammamish', 'issaquah', 'shoreline', 'burien', 'lakewood'];
        if (pugetSoundCities.some(pc => c.includes(pc)) || (z >= '98000' && z <= '98599' && !z.startsWith('989'))) {
          return 'Greater Puget Sound / Seattle Metro';
        }

        // Tri-Cities & Mid-Columbia
        const triCities = ['kennewick', 'pasco', 'richland', 'west richland', 'moses lake', 'walla walla', 'othello', 'prosser', 'burbank', 'finley'];
        if (triCities.some(tc => c.includes(tc)) || z.startsWith('993') || z.startsWith('98837')) {
          return 'Tri-Cities & Mid-Columbia';
        }

        // Spokane & Inland Northwest
        const spokaneCities = ['spokane', 'spokane valley', 'cheney', 'liberty lake', 'airway heights', 'deer park', 'pullman', 'mead', 'colbert', 'medical lake'];
        if (spokaneCities.some(sc => c.includes(sc)) || z.startsWith('990') || z.startsWith('991') || z.startsWith('992') || z.startsWith('994')) {
          return 'Spokane & Inland Northwest';
        }

        // North Central WA / Cascades
        if (c.includes('wenatchee') || c.includes('leavenworth') || c.includes('chelan') || c.includes('omak') || z.startsWith('988')) {
          return 'North Central WA (Wenatchee & Cascades)';
        }

        // SW Washington / Vancouver Area
        if (c.includes('vancouver') || c.includes('camas') || c.includes('washougal') || c.includes('battle ground') || z.startsWith('986')) {
          return 'Greater Portland & SW Washington';
        }

        return 'Washington State Regional Market';
      }

      // --- 2. Oregon State Clusters ---
      if (s === 'OR') {
        // Greater Portland Metro
        const portlandCities = ['portland', 'beaverton', 'hillsboro', 'gresham', 'tigard', 'lake oswego', 'tualatin', 'west linn', 'oregon city', 'wilsonville', 'milwaukie', 'clackamas', 'happy valley', 'sherwood'];
        if (portlandCities.some(p => c.includes(p)) || z.startsWith('970') || z.startsWith('971') || z.startsWith('972')) {
          return 'Greater Portland Metro';
        }

        // Willamette Valley (Salem, Eugene, Corvallis, Albany)
        const valleyCities = ['salem', 'eugene', 'springfield', 'corvallis', 'albany', 'keizer', 'mcminnville', 'woodburn'];
        if (valleyCities.some(v => c.includes(v)) || z.startsWith('973') || z.startsWith('974')) {
          return 'Willamette Valley (Salem & Eugene)';
        }

        // Central Oregon (Bend / Deschutes)
        const centralOr = ['bend', 'redmond', 'sisters', 'sunriver', 'prineville', 'madras'];
        if (centralOr.some(co => c.includes(co)) || z.startsWith('977')) {
          return 'Central Oregon (Bend & High Desert)';
        }

        // Southern Oregon
        const southOr = ['medford', 'ashland', 'grants pass', 'klamath falls', 'roseburg'];
        if (southOr.some(so => c.includes(so)) || z.startsWith('975') || z.startsWith('976')) {
          return 'Southern Oregon Market';
        }

        return 'Oregon Regional Market';
      }

      // --- 3. Idaho State Clusters ---
      if (s === 'ID') {
        const treasureValley = ['boise', 'meridian', 'nampa', 'caldwell', 'eagle', 'kuna', 'star'];
        if (treasureValley.some(tv => c.includes(tv)) || z.startsWith('836') || z.startsWith('837')) {
          return 'Boise & Treasure Valley';
        }

        const northId = ['coeur d\'alene', 'post falls', 'hayden', 'sandpoint', 'moscow', 'lewiston'];
        if (northId.some(ni => c.includes(ni)) || z.startsWith('838') || z.startsWith('835')) {
          return 'Spokane & Inland Northwest (North Idaho)';
        }

        return 'Idaho Regional Market';
      }

      // --- 4. California Clusters ---
      if (s === 'CA') {
        if (z.startsWith('940') || z.startsWith('941') || z.startsWith('943') || z.startsWith('944') || z.startsWith('945') || z.startsWith('946') || z.startsWith('947') || z.startsWith('948') || z.startsWith('950') || z.startsWith('951') || c.includes('san francisco') || c.includes('san jose') || c.includes('oakland')) {
          return 'San Francisco Bay Area';
        }
        if (z.startsWith('900') || z.startsWith('901') || z.startsWith('902') || z.startsWith('903') || z.startsWith('904') || z.startsWith('905') || z.startsWith('906') || z.startsWith('907') || z.startsWith('908') || z.startsWith('910') || z.startsWith('911') || z.startsWith('912') || z.startsWith('913') || z.startsWith('914') || z.startsWith('915') || z.startsWith('916') || z.startsWith('917') || z.startsWith('918') || z.startsWith('926') || z.startsWith('927') || z.startsWith('928') || c.includes('los angeles')) {
          return 'Greater Los Angeles Metro';
        }
        if (z.startsWith('919') || z.startsWith('920') || z.startsWith('921') || c.includes('san diego')) {
          return 'San Diego Metro';
        }
        if (z.startsWith('956') || z.startsWith('957') || z.startsWith('958') || c.includes('sacramento')) {
          return 'Greater Sacramento Metro';
        }
        return 'California Regional Market';
      }

      // --- 5. All Other US States (Dynamic Capitalized Format) ---
      const formattedCity = city ? city.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') : 'Metro';
      return 'Greater ' + formattedCity + ' Metro (' + (s || 'US') + ')';
    },

    /**
     * Resolves default warehouse facility ID for a given ZIP code
     * @param {string|number} zip - 5-digit US ZIP code
     * @returns {string} Facility identifier
     */
    resolveFacilityForZip(zip) {
      const z = String(zip || '').trim().replace(/\D/g, '').slice(0, 5);
      if (!z) return 'facility_yakima';
      if (z.startsWith('980') || z.startsWith('981') || z.startsWith('982') || z.startsWith('983') || z.startsWith('984') || z.startsWith('985')) {
        return 'facility_seattle_north';
      }
      if (z.startsWith('970') || z.startsWith('971') || z.startsWith('972') || z.startsWith('973') || z.startsWith('974') || z.startsWith('975') || z.startsWith('976') || z.startsWith('977') || z.startsWith('978')) {
        return 'facility_portland_central';
      }
      if (z.startsWith('990') || z.startsWith('991') || z.startsWith('992') || z.startsWith('993') || z.startsWith('994')) {
        return 'facility_spokane_hub';
      }
      if (z.startsWith('989')) {
        return 'facility_yakima';
      }
      return 'facility_yakima';
    },

    /**
     * Validates if entered City and State match the postal registration for a ZIP
     * @returns {Object} Validation outcome with canonical recommendations
     */
    validateCityStateZip(enteredCity, enteredState, enteredZip, zipData) {
      if (!zipData) {
        return {
          isValid: true,
          isMismatch: false,
          canonicalCity: enteredCity || '',
          canonicalState: (enteredState || '').toUpperCase(),
          message: ''
        };
      }

      const normEnteredCity = (enteredCity || '').toLowerCase().trim();
      const normEnteredState = (enteredState || '').toUpperCase().trim();
      const canonicalCity = zipData.city;
      const canonicalState = zipData.state;

      // Check if city matches primary or any alternative postal places for this zip
      const isCityMatch = !normEnteredCity || zipData.allPlaces.includes(normEnteredCity) || normEnteredCity === canonicalCity.toLowerCase();
      // Check if state matches
      const isStateMatch = !normEnteredState || normEnteredState === canonicalState || normEnteredState === (zipData.stateFullName || '').toUpperCase();

      const isMismatch = (!isCityMatch || !isStateMatch) && !!normEnteredCity;

      let message = '';
      if (isMismatch) {
        if (!isCityMatch && !isStateMatch) {
          message = 'ZIP ' + zipData.zip + ' is registered to ' + canonicalCity + ', ' + canonicalState + '.';
        } else if (!isCityMatch) {
          message = 'ZIP ' + zipData.zip + ' is located in ' + canonicalCity + ' (' + canonicalState + '), not ' + enteredCity + '.';
        } else if (!isStateMatch) {
          message = 'ZIP ' + zipData.zip + ' is in ' + canonicalState + ', not ' + enteredState + '.';
        }
      }

      return {
        isValid: !isMismatch,
        isMismatch: isMismatch,
        canonicalCity: canonicalCity,
        canonicalState: canonicalState,
        regionalMarket: zipData.regionalMarket,
        message: message
      };
    },

    /**
     * Attaches live auto-completion and mismatch detection to any City/State/ZIP form inputs
     */
    attachAutofill(config) {
      const {
        zipEl,
        cityEl,
        stateEl,
        feedbackEl,
        onResolved,
        allowAutoCorrection = true
      } = config;

      if (!zipEl) return;

      const handleZipChange = async () => {
        const rawZip = (zipEl.value || '').trim().replace(/\D/g, '').slice(0, 5);
        if (rawZip.length !== 5) {
          if (feedbackEl) {
            feedbackEl.classList.add('hidden');
            feedbackEl.innerHTML = '';
          }
          return;
        }

        const zipData = await this.lookupZip(rawZip);
        if (!zipData) {
          if (feedbackEl) {
            feedbackEl.innerHTML = '<span class="text-rose-500 font-bold">⚠️ Unrecognized 5-digit US ZIP Code.</span>';
            feedbackEl.classList.remove('hidden');
          }
          if (typeof onResolved === 'function') onResolved(null);
          return;
        }

        // Auto-fill empty fields or auto-correct if requested
        const currentCity = cityEl ? cityEl.value.trim() : '';
        const currentState = stateEl ? stateEl.value.trim() : '';

        if (cityEl && (!currentCity || (allowAutoCorrection && currentCity.toLowerCase() !== zipData.city.toLowerCase()))) {
          cityEl.value = zipData.city;
        }
        if (stateEl && (!currentState || allowAutoCorrection)) {
          stateEl.value = zipData.state;
        }

        const validation = this.validateCityStateZip(currentCity, currentState, rawZip, zipData);

        if (feedbackEl) {
          if (validation.isMismatch && !allowAutoCorrection) {
            feedbackEl.innerHTML = '<div class="flex items-center justify-between text-xs text-amber-700 bg-amber-50 border border-amber-200 p-2 rounded-lg mt-1 font-medium"><span>📍 ' + validation.message + '</span></div>';
            feedbackEl.classList.remove('hidden');
          } else {
            feedbackEl.innerHTML = '<div class="text-[11px] text-emerald-700 font-bold mt-1">✓ ' + zipData.city + ', ' + zipData.state + ' (' + zipData.regionalMarket + ')</div>';
            feedbackEl.classList.remove('hidden');
          }
        }

        if (typeof onResolved === 'function') {
          onResolved(zipData);
        }
      };

      zipEl.addEventListener('input', () => {
        const val = zipEl.value.replace(/\D/g, '').slice(0, 5);
        if (val.length === 5) {
          handleZipChange();
        } else if (feedbackEl) {
          feedbackEl.classList.add('hidden');
        }
      });

      zipEl.addEventListener('blur', handleZipChange);
    }
  };

  // Export globally
  global.AddressValidator = AddressValidator;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AddressValidator;
  }
})(typeof window !== 'undefined' ? window : globalThis);

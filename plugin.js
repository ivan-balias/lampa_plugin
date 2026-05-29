(function () {
  'use strict';

  // ====== КОНФІГУРАЦІЯ ======
  var SITE_URL = 'https://rezka-ua.co';
  var PLUGIN_NAME = 'HDRezka';

  // ====== УТИЛІТИ ======
  function request(url, params) {
    return new Promise(function (resolve, reject) {
      var body = new URLSearchParams(params).toString();
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: body
      })
        .then(function (r) { return r.json(); })
        .then(resolve)
        .catch(reject);
    });
  }

  // Парсинг рядка з URL-потоками
  // Формат: [360p]url1:hls:manifest.m3u8 or [720p]url2:hls:manifest.m3u8
  function parseStreams(urlString) {
    var streams = [];
    var regex = /\[([^\]]+)\](https?:\/\/[^,\s]+)/g;
    var match;
    while ((match = regex.exec(urlString)) !== null) {
      streams.push({ label: match[1], url: match[2] });
    }
    // Сортуємо за якістю (найкраща спочатку)
    var order = ['2160p', '1080p', '720p', '480p', '360p'];
    streams.sort(function (a, b) {
      return order.indexOf(a.label) - order.indexOf(b.label);
    });
    return streams;
  }

  // Пошук серіалів через сайт
  function search(query, page) {
    return fetch(SITE_URL + '/search/?do=search&subaction=search&q=' + encodeURIComponent(query) + '&page=' + (page || 1))
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(html, 'text/html');
        var items = [];
        doc.querySelectorAll('.b-content__inline_item').forEach(function (el) {
          var link = el.querySelector('a.b-content__inline_item-link');
          var img = el.querySelector('img');
          var info = el.querySelector('.b-content__inline_item-link div');
          if (!link) return;
          var urlMatch = link.href.match(/\/(\d+)-[^\/]+\.html/);
          items.push({
            id: urlMatch ? urlMatch[1] : '',
            title: link.querySelector('div') ? link.querySelector('div').textContent.trim() : '',
            year: info ? info.textContent.trim() : '',
            poster: img ? img.src : '',
            url: link.href
          });
        });
        return items;
      });
  }

  // Отримання списку озвучок та сезонів зі сторінки тайтлу
  function getTranslators(titleUrl) {
    return fetch(titleUrl)
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var parser = new DOMParser();
        var doc = parser.parseFromString(html, 'text/html');
        var translators = [];
        doc.querySelectorAll('.b-translator__item').forEach(function (el) {
          translators.push({
            id: el.dataset.translatorId,
            name: el.textContent.trim()
          });
        });
        // Якщо перекладачів немає — значить один вбудований
        if (translators.length === 0) {
          var def = doc.querySelector('[data-translator_id]');
          if (def) {
            translators.push({ id: def.dataset.translator_id, name: 'Оригінал' });
          }
        }
        // Кількість сезонів
        var seasons = [];
        doc.querySelectorAll('.b-simple_season__item').forEach(function (el) {
          seasons.push({ id: el.dataset.tab, name: el.textContent.trim() });
        });
        // ID тайтлу
        var idMatch = html.match(/initCDNSeriesEvents\((\d+),/);
        var titleId = idMatch ? idMatch[1] : '';
        return { titleId: titleId, translators: translators, seasons: seasons };
      });
  }

  // Список епізодів для сезону
  function getEpisodes(titleId, translatorId, season) {
    return request(SITE_URL + '/ajax/get_cdn_series/', {
      id: titleId,
      translator_id: translatorId,
      season: season,
      episode: 1,
      action: 'get_episodes'
    });
  }

  // Отримати потік для конкретного епізоду
  function getStream(titleId, translatorId, season, episode) {
    return request(SITE_URL + '/ajax/get_cdn_series/', {
      id: titleId,
      translator_id: translatorId,
      season: season,
      episode: episode,
      action: 'get_stream'
    }).then(function (data) {
      if (!data.success) throw new Error(data.message || 'API error');
      return parseStreams(data.url);
    });
  }

  // ====== LAMPA PLUGIN API ======
  Lampa.Plugin.add(PLUGIN_NAME, function (plugin) {

    // Реєструємо джерело (source)
    Lampa.Source.add(PLUGIN_NAME, {
      name: PLUGIN_NAME,
      logo: SITE_URL + '/templates/HdRezka/images/logo.png',

      // Пошук
      search: function (params, oncomplete, onerror) {
        search(params.query, params.page || 1)
          .then(oncomplete)
          .catch(onerror);
      },

      // Дані для картки (трансформуємо у формат Lampa)
      card: function (item) {
        return {
          id: item.id,
          title: item.title,
          poster: item.poster,
          source: PLUGIN_NAME,
          url: item.url
        };
      },

      // Список сезонів/озвучок
      seasons: function (card, oncomplete, onerror) {
        getTranslators(card.url)
          .then(function (data) {
            card._rezka = data; // зберігаємо для подальших запитів
            oncomplete(data.seasons);
          })
          .catch(onerror);
      },

      // Список епізодів
      episodes: function (card, season, oncomplete, onerror) {
        var rezka = card._rezka;
        var translatorId = rezka.translators[0] ? rezka.translators[0].id : '';
        getEpisodes(rezka.titleId, translatorId, season.id)
          .then(function (data) {
            var episodes = [];
            if (data.episodes) {
              var parser = new DOMParser();
              var doc = parser.parseFromString(data.episodes, 'text/html');
              doc.querySelectorAll('.b-simple_episode__item').forEach(function (el) {
                episodes.push({ id: el.dataset.episode, name: el.textContent.trim() });
              });
            }
            oncomplete(episodes);
          })
          .catch(onerror);
      },

      // Відтворення
      play: function (card, params, oncomplete, onerror) {
        var rezka = card._rezka;
        var translatorId = rezka.translators[0] ? rezka.translators[0].id : '';
        var season = params.season ? params.season.id : 1;
        var episode = params.episode ? params.episode.id : 1;

        getStream(rezka.titleId, translatorId, season, episode)
          .then(function (streams) {
            if (!streams.length) return onerror('Немає потоків');
            // Передаємо найкращу якість + усі варіанти
            oncomplete({
              url: streams[0].url,
              title: card.title,
              quality: streams.map(function (s) {
                return { label: s.label, url: s.url };
              })
            });
          })
          .catch(onerror);
      }
    });

    plugin.ready();
  });

})();

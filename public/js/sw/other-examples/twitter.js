(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
// no_unit_test
  module.exports = {
    visible: function(client) { return client.visibilityState === 'visible'; },
    topLevel: function(client) { return client.frameType === 'top-level'; },
    focused: function(client) { return client.focused; },
    urlEndsWith: function(endsWith) {
      return function(client) { return client.url.endsWith(endsWith); };
    }
  };

},{}],2:[function(require,module,exports){
  var clientFilters = require('app/workers/client_filters');
  var utils = require('app/workers/utils');

// Focus and trigger an event on client if available
// Otherwise, open the URL provided by the notification
  var dmNotificationClickHandler = function(data) {
    return utils.getClients().then(function(clientList) {
      var activeClient = clientList[0];
      if (activeClient && activeClient.focus) {
        activeClient.focus();
        utils.triggerOnClient(activeClient, 'uiDMNotificationClicked', data.notificationData);
        return Promise.resolve();
      } else {
        return utils.openURL(data.url || '/');
      }
    });
  };

  var defaultNotificationClickHandler = function(data) {
    var endsWithFilter = clientFilters.urlEndsWith(data.url);
    return utils.getClients([endsWithFilter]).then(function(clientList) {
      var client = clientList[0];
      return Promise.resolve(client && client.focus ? client.focus() : utils.openURL(data.url));
    });
  };

  var notificationClickHandlers = {
    'dm': dmNotificationClickHandler,
    'default': defaultNotificationClickHandler
  };

  module.exports = notificationClickHandlers;

},{"app/workers/client_filters":1,"app/workers/utils":7}],3:[function(require,module,exports){
  var utils = require('app/workers/utils');

  var dmNotificationDisplayHandler = function(notification, visibleClient) {
    utils.triggerOnClient(visibleClient, 'dataDMPushReceived', notification.data.notificationData);
  };

// Suppress error notification if there's a visible client
  var errorNotificationHandler = function() { return; };

  var notificationDisplayHandlers = {
    'dm': dmNotificationDisplayHandler,
    'error': errorNotificationHandler,
    'default': utils.displayNotification
  };

  module.exports = notificationDisplayHandlers;

},{"app/workers/utils":7}],4:[function(require,module,exports){
  /*
   * To bundle service worker file, run `npm run build:service-worker` in `web-resources` directory
   */

  var utils = require('app/workers/utils');
  var clientFilters = require('app/workers/client_filters');
  var notificationClickHandlers = require('app/workers/notification_click_handlers');
  var notificationDisplayHandlers = require('app/workers/notification_display_handlers');
  var scribeHelper = require('app/workers/scribe');

  var NOTIFICATIONS_ENDPOINT = '/i/push_notifications';
  var WORKER_API_VERSION = 1;
  var DB;

  function PushServiceWorker() {
    this.scribe = scribeHelper;

    /*
     *
     * Logic for fetching the JSON notifications from the endpoint
     * dealing with the response and displaying the notifications
     *
     */
    this.displayNotifications = function(notifications) {
      if (!notifications) {
        return Promise.resolve();
      }
      return Promise.all(notifications.map(function(notification) {
        this.scribe({
          element: notification.data && notification.data.scribeElementName ? notification.data.scribeElementName : 'other',
          action: 'impression'
        }, {
          event_value: notification.data.pushId
        });

        // Chrome requires that a notification be shown before the push event is completed
        // unless theres's a visible client window so we only delegate display handling in that case
        return utils.getClients([clientFilters.visible]).then(function(clientList) {
          var visibleClient = clientList[0];
          var notificationType = notification.data.notificationType;
          var displayHandler = (visibleClient && notificationDisplayHandlers[notificationType]) || notificationDisplayHandlers['default'];
          return displayHandler(notification, visibleClient);
        });
      }.bind(this)));
    };

    this.fetchNotifications = function(cursors, pushId) {
      var params = [
        'apiv=' + WORKER_API_VERSION,
        cursors.dm && 'dm_cursor=' + encodeURIComponent(cursors.dm),
        cursors.interactions && 'min_position=' + encodeURIComponent(cursors.interactions)
      ].filter(function(param) {
        return !!param;
      });

      return self.fetch(NOTIFICATIONS_ENDPOINT + '?' + params.join('&'), { credentials: 'include' })
          .then(function(response) { return response.json(); })
          .then(function(data) { return (data.error || !data.notifications) ? Promise.reject('Invalid API response') : data; })
          .then(function(data) { return this.storeCursorsFromResponse(data); }.bind(this))
          .then(function(data) {
            data.notifications.forEach(function(notification) { notification.data.pushId = pushId; });
            return data.notifications;
          })
          .catch(function(err) {
            // Unable to fetch data for some reason, most likely they are logged out
            this.scribe({ action: 'fetch_failure' }, { event_value: pushId, message: err.message });
          }.bind(this));
    };

    this.pushHandler = function(pushEvent) {
      var pushId = utils.generatePushId();
      this.scribe({
        action: 'received'
      }, {
        event_value: pushId
      });

      pushEvent.waitUntil(
          this.openIndexedDB('notification_cursors')
              .then(function(db) { return this.getCursors(db); }.bind(this))
              .then(function(cursors) { return this.fetchNotifications(cursors, pushId); }.bind(this))
              .then(function(notifications) { return this.displayNotifications(notifications); }.bind(this))
      );
    };

    this.notificationcloseHandler = function(event) {
      var data = event.notification.data;
      this.scribe({
        element: data ? data.scribeElementName : 'other',
        action: 'dismiss'
      }, {
        event_value: data.pushId
      });
    };

    this.notificationclickHandler = function(event) {
      event.notification.close();

      var data = event.notification.data;
      this.scribe({
        element: data ? data.scribeElementName : 'other',
        action: 'click'
      }, {
        event_value: data.pushId
      });

      var clickHandler = notificationClickHandlers[data.notificationType] || notificationClickHandlers['default'];
      event.waitUntil(clickHandler(data));
    };

    /*
     * Indexed DB Interface
     */
    this.openIndexedDB = function(name) {
      return new Promise(function(resolve, reject) {
        if (DB) {
          resolve(DB);
        } else {
          var request = self.indexedDB.open(name);
          request.onsuccess = function(event) {
            DB = event.target.result;
            DB.onversionchange = function(event) {
              DB.close();
              DB = null;
            };
            resolve(DB);
          };
          request.onerror = request.onblocked = reject;
        }
      });
    };

    this.getCursors = function(db) {
      return new Promise(function(resolve, reject) {
        var request = db.transaction('cursors').objectStore('cursors').openCursor();
        var cursors = {};

        request.onsuccess = function(event) {
          var cursor = event.target.result;
          if (cursor) {
            cursors[cursor.value.name] = cursor.value.cursor;
            cursor.continue();
          } else {
            resolve(cursors);
          }
        };
        request.onerror = reject;
      });
    };

    this.storeCursorsFromResponse = function(data) {
      return this.openIndexedDB('notification_cursors').then(function(db) {
        if (data.dmCursor) {
          db.transaction(['cursors'], 'readwrite').objectStore('cursors').put({name: 'dm', cursor: data.dmCursor});
        }
        if (data.interactionsCursor) {
          db.transaction(['cursors'], 'readwrite').objectStore('cursors').put({name: 'interactions', cursor: data.interactionsCursor});
        }
        return data;
      });
    };

    /*
     * Service worker interface
     */
    this.initialize = function() {
      self.addEventListener('push', this.pushHandler.bind(this));

      self.addEventListener('notificationclose', this.notificationcloseHandler.bind(this));

      self.addEventListener('notificationclick', this.notificationclickHandler.bind(this));

      // Make this worker active as soon as it's fetched instead of waiting for page close like normal
      self.addEventListener('install', function(event) { return event.waitUntil(self.skipWaiting()); });
      self.addEventListener('activate', function(event) { return event.waitUntil(self.clients.claim()); });
    };
  }

  module.exports = new PushServiceWorker();

},{"app/workers/client_filters":1,"app/workers/notification_click_handlers":2,"app/workers/notification_display_handlers":3,"app/workers/scribe":6,"app/workers/utils":7}],5:[function(require,module,exports){
// no_unit_test
  var pushServiceWorker = require('app/workers/push_service_worker');

  pushServiceWorker.initialize();

},{"app/workers/push_service_worker":4}],6:[function(require,module,exports){
// no_unit_test
  var utils = require('app/workers/utils');
  var CLIENT_APP_ID = 268278;

  /*
   * Lightweight scribe interface for logging display and clicks
   */
  var scribe = function(terms, data) {
    data = data || {};

    if (!terms || !terms.action) {
      throw new Error('You must specify an action term in your client_event.');
    }

    // http://go/clienteventnamespace for details
    var eventNamespace = {
      client: 'web',
      page: 'service_worker',
      section: (terms.section || ''),
      component: (terms.component || ''),
      element: (terms.element || ''),
      action: terms.action
    };

    var json = Object.assign({}, data, {
      event_namespace: eventNamespace,
      _category_: 'client_event',
      triggered_on: utils.getDate(),
      format_version: 2,
      client_app_id: CLIENT_APP_ID // Desktop Web
    });

    self.fetch('/i/jot', {
      credentials: 'include',
      method: 'post',
      headers: {
        'Accept': 'application/x-www-form-urlencoded',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'log=' + encodeURIComponent(JSON.stringify(json))
    });
  };

  module.exports = scribe;

},{"app/workers/utils":7}],7:[function(require,module,exports){
  var clientFilters = require('app/workers/client_filters');

  /* Service Worker utils */
  module.exports = {
    displayNotification: function(notification) {
      return self.registration.showNotification(notification.title, notification);
    },

    getDate: Date.now,

    generatePushId: function() { return parseInt((Math.random() * Number.MAX_SAFE_INTEGER), 10); },

    combineFilters: function(filters) {
      return function(item) {
        return filters.every(function(filter) {
          return filter(item);
        });
      };
    },

    getClients: function(filters) {
      filters = filters || [];
      filters.push(clientFilters.topLevel);
      var combinedFilter = this.combineFilters(filters);
      return self.clients.matchAll({ type: 'window' }).then(function(clientList) {
        return clientList.filter(combinedFilter);
      });
    },

    triggerOnClient: function(client, eventName, eventData) {
      return client.postMessage(JSON.stringify({
        event: eventName,
        data: eventData
      }));
    },

    openURL: function(url, client) {
      url = url || '/';
      if (client && client.navigate) {
        client.focus && client.focus();
        return client.navigate(url);
      } else if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      } else {
        return Promise.reject('Opening a URL via service worker is not supported in this browser');
      }
    }
  };

},{"app/workers/client_filters":1}]},{},[5]);
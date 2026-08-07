/* SPDX-License-Identifier: GPL-3.0-or-later */
#include <emscripten/emscripten.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "toxcore/net.h"
#include "toxcore/network.h"
#include "toxcore/tox.h"
#include "toxcore/tox_private.h"

EM_JS(int, relay_js_socket, (int domain, int type, int protocol), {
    return Module['relayNetSocket'](domain, type, protocol) | 0;
});

EM_JS(int, relay_js_has_network, (), {
    return Module['relayHasDirectSockets']() ? 1 : 0;
});

EM_JS(int, relay_js_bind, (int handle, int family, int port), {
    return Module['relayNetBind'](handle, family, port) | 0;
});

EM_JS(int, relay_js_connect, (int handle, const char *host, int port), {
    return Module['relayNetConnect'](handle, UTF8ToString(host), port) | 0;
});

EM_JS(int, relay_js_send, (int handle, const uint8_t *data, int length), {
    return Module['relayNetSend'](handle, HEAPU8.slice(data, data + length)) | 0;
});

EM_JS(int, relay_js_sendto, (int handle, const uint8_t *data, int length, const char *host, int port), {
    return Module['relayNetSendTo'](handle, HEAPU8.slice(data, data + length), UTF8ToString(host), port) | 0;
});

EM_JS(int, relay_js_recv, (int handle, uint8_t *buffer, int maximum), {
    const data = Module['relayNetReceive'](handle, maximum);
    if (!data) return -1;
    HEAPU8.set(data, buffer);
    return data.byteLength | 0;
});

EM_JS(int, relay_js_recvfrom, (int handle, uint8_t *buffer, int maximum, int *family, uint8_t *ip, int *port), {
    const packet = Module['relayNetReceiveFrom'](handle, maximum);
    if (!packet) return -1;
    HEAPU8.set(packet.data, buffer);
    HEAPU8.set(packet.address, ip);
    HEAP32[family >> 2] = packet.family | 0;
    HEAP32[port >> 2] = packet.port | 0;
    return packet.data.byteLength | 0;
});

EM_JS(int, relay_js_recvbuf, (int handle), {
    return Module['relayNetReceiveBufferSize'](handle) | 0;
});

EM_JS(int, relay_js_close, (int handle), {
    return Module['relayNetClose'](handle) | 0;
});

EM_JS(void, relay_js_emit_connection, (int status), {
    Module['relayEmit']({ type: 'connection', status });
});

EM_JS(void, relay_js_emit_friend_connection, (uint32_t friend_number, int status), {
    Module['relayEmit']({ type: 'friend-connection', friendNumber: friend_number >>> 0, status });
});

EM_JS(void, relay_js_emit_friend_request, (const uint8_t *public_key, const uint8_t *message, int length), {
    const hex = Array.from(HEAPU8.subarray(public_key, public_key + 32), value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
    const text = new TextDecoder().decode(HEAPU8.slice(message, message + length));
    Module['relayEmit']({ type: 'friend-request', publicKey: hex, message: text });
});

EM_JS(void, relay_js_emit_message, (uint32_t friend_number, int message_type, const uint8_t *message, int length), {
    const text = new TextDecoder().decode(HEAPU8.slice(message, message + length));
    Module['relayEmit']({ type: 'message', friendNumber: friend_number >>> 0, messageType: message_type, text });
});

EM_JS(void, relay_js_emit_receipt, (uint32_t friend_number, uint32_t message_id), {
    Module['relayEmit']({ type: 'receipt', friendNumber: friend_number >>> 0, messageId: message_id >>> 0 });
});

static Socket bridge_socket(void *obj, int domain, int type, int protocol)
{
    (void)obj;
    return net_socket_from_native(relay_js_socket(domain, type, protocol));
}

static int bridge_close(void *obj, Socket socket)
{
    (void)obj;
    return relay_js_close(net_socket_to_native(socket));
}

static int bridge_bind(void *obj, Socket socket, const IP_Port *address)
{
    (void)obj;
    return relay_js_bind(net_socket_to_native(socket), address->ip.family.value, net_ntohs(address->port));
}

static int bridge_connect(void *obj, Socket socket, const IP_Port *address)
{
    (void)obj;
    char host[TOX_INET6_ADDRSTRLEN] = {0};
    if (!ip_parse_addr(&address->ip, host, sizeof(host))) return -1;
    return relay_js_connect(net_socket_to_native(socket), host, net_ntohs(address->port));
}

static int bridge_recvbuf(void *obj, Socket socket)
{
    (void)obj;
    return relay_js_recvbuf(net_socket_to_native(socket));
}

static int bridge_recv(void *obj, Socket socket, uint8_t *buffer, size_t length)
{
    (void)obj;
    const int result = relay_js_recv(net_socket_to_native(socket), buffer, (int)length);
    if (result < 0) errno = EWOULDBLOCK;
    return result;
}

static int bridge_recvfrom(void *obj, Socket socket, uint8_t *buffer, size_t length, IP_Port *address)
{
    (void)obj;
    int family = 0;
    int port = 0;
    uint8_t ip[SIZE_IP6] = {0};
    const int result = relay_js_recvfrom(net_socket_to_native(socket), buffer, (int)length, &family, ip, &port);
    if (result < 0) {
        errno = EWOULDBLOCK;
        return result;
    }
    address->ip.family.value = (uint8_t)family;
    if (family == TOX_AF_INET) memcpy(address->ip.ip.v4.uint8, ip, SIZE_IP4);
    else if (family == TOX_AF_INET6) memcpy(address->ip.ip.v6.uint8, ip, SIZE_IP6);
    else return -1;
    address->port = net_htons((uint16_t)port);
    return result;
}

static int bridge_send(void *obj, Socket socket, const uint8_t *buffer, size_t length)
{
    (void)obj;
    const int result = relay_js_send(net_socket_to_native(socket), buffer, (int)length);
    if (result < 0) errno = EWOULDBLOCK;
    return result;
}

static int bridge_sendto(void *obj, Socket socket, const uint8_t *buffer, size_t length, const IP_Port *address)
{
    (void)obj;
    char host[TOX_INET6_ADDRSTRLEN] = {0};
    if (!ip_parse_addr(&address->ip, host, sizeof(host))) return -1;
    const int result = relay_js_sendto(net_socket_to_native(socket), buffer, (int)length, host, net_ntohs(address->port));
    if (result < 0) errno = EWOULDBLOCK;
    return result;
}

static Socket bridge_accept(void *obj, Socket socket) { (void)obj; (void)socket; return net_invalid_socket(); }
static int bridge_listen(void *obj, Socket socket, int backlog) { (void)obj; (void)socket; (void)backlog; return -1; }
static int bridge_nonblock(void *obj, Socket socket, bool nonblock) { (void)obj; (void)socket; (void)nonblock; return 0; }
static int bridge_getsockopt(void *obj, Socket socket, int level, int option, void *value, size_t *length)
{
    (void)obj; (void)socket; (void)level; (void)option;
    if (*length >= sizeof(int)) { *(int *)value = 0; *length = sizeof(int); return 0; }
    return -1;
}
static int bridge_setsockopt(void *obj, Socket socket, int level, int option, const void *value, size_t length)
{ (void)obj; (void)socket; (void)level; (void)option; (void)value; (void)length; return 0; }
static int bridge_getaddrinfo(void *obj, const Memory *mem, const char *address, int family, int protocol, IP_Port **addrs)
{ (void)obj; (void)mem; (void)address; (void)family; (void)protocol; *addrs = NULL; return 0; }
static int bridge_freeaddrinfo(void *obj, const Memory *mem, IP_Port *addrs)
{ (void)obj; (void)mem; (void)addrs; return 0; }

static const Network_Funcs bridge_network_funcs = {
    bridge_close, bridge_accept, bridge_bind, bridge_listen, bridge_connect,
    bridge_recvbuf, bridge_recv, bridge_recvfrom, bridge_send, bridge_sendto,
    bridge_socket, bridge_nonblock, bridge_getsockopt, bridge_setsockopt,
    bridge_getaddrinfo, bridge_freeaddrinfo,
};
static const Network bridge_network = {&bridge_network_funcs, NULL};

static void on_self_connection(Tox *tox, Tox_Connection status, void *user_data)
{ (void)tox; (void)user_data; relay_js_emit_connection((int)status); }
static void on_friend_connection(Tox *tox, Tox_Friend_Number friend_number, Tox_Connection status, void *user_data)
{ (void)tox; (void)user_data; relay_js_emit_friend_connection(friend_number, (int)status); }
static void on_friend_request(Tox *tox, const Tox_Public_Key public_key, const uint8_t *message, size_t length, void *user_data)
{ (void)tox; (void)user_data; relay_js_emit_friend_request(public_key, message, (int)length); }
static void on_friend_message(Tox *tox, Tox_Friend_Number friend_number, Tox_Message_Type type, const uint8_t *message, size_t length, void *user_data)
{ (void)tox; (void)user_data; relay_js_emit_message(friend_number, (int)type, message, (int)length); }
static void on_friend_receipt(Tox *tox, Tox_Friend_Number friend_number, Tox_Friend_Message_Id message_id, void *user_data)
{ (void)tox; (void)user_data; relay_js_emit_receipt(friend_number, message_id); }

EMSCRIPTEN_KEEPALIVE Tox *relay_tox_new(const uint8_t *savedata, size_t savedata_length)
{
    Tox_Err_Options_New options_error;
    Tox_Options *options = tox_options_new(&options_error);
    if (options == NULL) return NULL;
    tox_options_set_ipv6_enabled(options, true);
    tox_options_set_udp_enabled(options, relay_js_has_network() != 0);
    tox_options_set_local_discovery_enabled(options, false);
    tox_options_set_start_port(options, 0);
    tox_options_set_end_port(options, 0);
    if (savedata != NULL && savedata_length > 0) {
        tox_options_set_savedata_type(options, TOX_SAVEDATA_TYPE_TOX_SAVE);
        tox_options_set_savedata_data(options, savedata, savedata_length);
    }
    Tox_System system = tox_default_system();
    system.ns = &bridge_network;
    const Tox_Options_Testing testing = {&system};
    Tox_Err_New error;
    Tox_Err_New_Testing testing_error;
    Tox *tox = tox_new_testing(options, &error, &testing, &testing_error);
    tox_options_free(options);
    if (tox == NULL) return NULL;
    tox_callback_self_connection_status(tox, on_self_connection);
    tox_callback_friend_connection_status(tox, on_friend_connection);
    tox_callback_friend_request(tox, on_friend_request);
    tox_callback_friend_message(tox, on_friend_message);
    tox_callback_friend_read_receipt(tox, on_friend_receipt);
    return tox;
}

EMSCRIPTEN_KEEPALIVE void relay_tox_kill(Tox *tox) { tox_kill(tox); }
EMSCRIPTEN_KEEPALIVE void relay_tox_iterate(Tox *tox) { tox_iterate(tox, NULL); }
EMSCRIPTEN_KEEPALIVE uint32_t relay_tox_interval(Tox *tox) { return tox_iteration_interval(tox); }
EMSCRIPTEN_KEEPALIVE void relay_tox_address(Tox *tox, uint8_t *output) { tox_self_get_address(tox, output); }
EMSCRIPTEN_KEEPALIVE size_t relay_tox_savedata_size(Tox *tox) { return tox_get_savedata_size(tox); }
EMSCRIPTEN_KEEPALIVE void relay_tox_savedata(Tox *tox, uint8_t *output) { tox_get_savedata(tox, output); }

EMSCRIPTEN_KEEPALIVE int relay_tox_set_name(Tox *tox, const uint8_t *name, size_t length)
{ Tox_Err_Set_Info error; return tox_self_set_name(tox, name, length, &error) ? 0 : -(int)error - 1; }
EMSCRIPTEN_KEEPALIVE int relay_tox_set_status(Tox *tox, const uint8_t *status, size_t length)
{ Tox_Err_Set_Info error; return tox_self_set_status_message(tox, status, length, &error) ? 0 : -(int)error - 1; }

EMSCRIPTEN_KEEPALIVE int64_t relay_tox_add_friend(Tox *tox, const uint8_t *address, const uint8_t *message, size_t length)
{ Tox_Err_Friend_Add error; const Tox_Friend_Number number = tox_friend_add(tox, address, message, length, &error); return error == TOX_ERR_FRIEND_ADD_OK ? (int64_t)number : -(int64_t)error - 1; }
EMSCRIPTEN_KEEPALIVE int64_t relay_tox_accept_friend(Tox *tox, const uint8_t *public_key)
{ Tox_Err_Friend_Add error; const Tox_Friend_Number number = tox_friend_add_norequest(tox, public_key, &error); return error == TOX_ERR_FRIEND_ADD_OK ? (int64_t)number : -(int64_t)error - 1; }
EMSCRIPTEN_KEEPALIVE int relay_tox_remove_friend(Tox *tox, uint32_t friend_number)
{ Tox_Err_Friend_Delete error; return tox_friend_delete(tox, friend_number, &error) ? 0 : -(int)error - 1; }
EMSCRIPTEN_KEEPALIVE int64_t relay_tox_send_message(Tox *tox, uint32_t friend_number, const uint8_t *message, size_t length)
{ Tox_Err_Friend_Send_Message error; const uint32_t id = tox_friend_send_message(tox, friend_number, TOX_MESSAGE_TYPE_NORMAL, message, length, &error); return error == TOX_ERR_FRIEND_SEND_MESSAGE_OK ? (int64_t)id : -(int64_t)error - 1; }

EMSCRIPTEN_KEEPALIVE int relay_tox_bootstrap(Tox *tox, const char *host, uint16_t port, const uint8_t *public_key)
{ Tox_Err_Bootstrap error; return tox_bootstrap(tox, host, port, public_key, &error) ? 0 : -(int)error - 1; }
EMSCRIPTEN_KEEPALIVE int relay_tox_add_relay(Tox *tox, const char *host, uint16_t port, const uint8_t *public_key)
{ Tox_Err_Bootstrap error; return tox_add_tcp_relay(tox, host, port, public_key, &error) ? 0 : -(int)error - 1; }

EMSCRIPTEN_KEEPALIVE size_t relay_tox_friend_count(Tox *tox) { return tox_self_get_friend_list_size(tox); }
EMSCRIPTEN_KEEPALIVE void relay_tox_friend_numbers(Tox *tox, uint32_t *output) { tox_self_get_friend_list(tox, output); }
EMSCRIPTEN_KEEPALIVE int relay_tox_friend_public_key(Tox *tox, uint32_t friend_number, uint8_t *output)
{ Tox_Err_Friend_Get_Public_Key error; return tox_friend_get_public_key(tox, friend_number, output, &error) ? 0 : -(int)error - 1; }
